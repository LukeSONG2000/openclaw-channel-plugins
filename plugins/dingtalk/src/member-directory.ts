import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DingTalkDirectoryMember {
  displayName: string;
  names: string[];
  openDingTalkId?: string;
  userId?: string;
}

interface DingTalkMemberDirectoryOptions {
  binary?: string;
  cacheTtlMs?: number;
  log?: Pick<Console, "warn">;
}

function addName(names: Set<string>, value?: string): void {
  const name = value?.trim();
  if (!name) return;
  names.add(name);
  const withoutParentheses = name.replace(/\s*[（(][^）)]+[）)]\s*/g, "").trim();
  if (withoutParentheses) names.add(withoutParentheses);
  for (const match of name.matchAll(/[（(]([^）)]+)[）)]/g)) {
    const alias = match[1]?.trim();
    if (alias && alias.length >= 2) names.add(alias);
  }
}

export function buildDingTalkMemberAliases(member: DingTalkDirectoryMember): string[] {
  const names = new Set<string>();
  addName(names, member.displayName);
  for (const name of member.names) addName(names, name);

  const chineseName = member.names.find((name) => /^[\u3400-\u9fff]{2,4}$/.test(name.trim()))
    ?? (/^[\u3400-\u9fff]{2,4}$/.test(member.displayName) ? member.displayName : undefined);
  if (chineseName) {
    const givenName = chineseName.slice(1);
    if (givenName.length >= 2) names.add(givenName);
    names.add(`${chineseName.at(-1)}哥`);
  }

  return [...names].filter((name) => name.length >= 2).sort((a, b) => b.length - a.length);
}

export function findMentionedDingTalkMembers(
  text: string,
  members: DingTalkDirectoryMember[],
): DingTalkDirectoryMember[] {
  const aliasesByMember = members.map((member) => buildDingTalkMemberAliases(member));
  const owners = new Map<string, number>();
  for (const aliases of aliasesByMember) {
    for (const alias of new Set(aliases.map((value) => value.toLocaleLowerCase()))) {
      owners.set(alias, (owners.get(alias) ?? 0) + 1);
    }
  }
  const normalizedText = text.toLocaleLowerCase();
  return members.filter((_member, index) => aliasesByMember[index]?.some((alias) => {
    const normalizedAlias = alias.toLocaleLowerCase();
    return owners.get(normalizedAlias) === 1 && normalizedText.includes(normalizedAlias);
  }));
}

export class DingTalkMemberDirectory {
  private readonly groups = new Map<string, { expiresAt: number; members: DingTalkDirectoryMember[] }>();
  private readonly observed = new Map<string, DingTalkDirectoryMember[]>();
  private readonly binary: string;
  private readonly cacheTtlMs: number;

  constructor(private readonly options: DingTalkMemberDirectoryOptions = {}) {
    this.binary = options.binary ?? process.env.DWS_BIN ?? "dws";
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60_000;
  }

  observe(groupId: string, userId: string, displayName: string): void {
    if (!userId || !displayName) return;
    const members = this.observed.get(groupId) ?? [];
    const existing = members.find((member) => member.userId === userId);
    if (existing) {
      existing.displayName = displayName;
      if (!existing.names.includes(displayName)) existing.names.push(displayName);
    } else {
      members.push({ displayName, names: [displayName], userId });
    }
    this.observed.set(groupId, members);
  }

  async resolve(groupId: string, text: string): Promise<DingTalkDirectoryMember[]> {
    const members = await this.loadGroup(groupId);
    const mentioned = findMentionedDingTalkMembers(text, members);
    await Promise.all(mentioned.map((member) => this.resolveUserId(member)));
    const cached = this.groups.get(groupId);
    if (cached) {
      for (const member of mentioned) {
        const cachedMember = cached.members.find((item) =>
          (member.openDingTalkId && item.openDingTalkId === member.openDingTalkId)
          || item.displayName === member.displayName
        );
        if (cachedMember) cachedMember.userId = member.userId;
      }
    }
    return mentioned.filter((member) => Boolean(member.userId));
  }

  private async loadGroup(groupId: string): Promise<DingTalkDirectoryMember[]> {
    const cached = this.groups.get(groupId);
    if (cached && cached.expiresAt > Date.now()) return this.mergeObserved(groupId, cached.members);

    try {
      const { stdout } = await execFileAsync(this.binary, [
        "chat", "group", "members", "list",
        "--id", groupId,
        "--format", "json",
      ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      const parsed = JSON.parse(stdout) as {
        success?: boolean;
        result?: { list?: Array<{
          memberEmpName?: string;
          memberGroupNick?: string;
          memberNick?: string;
          openDingtalkId?: string;
        }> };
      };
      if (!parsed.success) throw new Error("DWS group member request failed");
      const members = (parsed.result?.list ?? []).flatMap((item) => {
        const displayName = item.memberGroupNick?.trim()
          || item.memberNick?.trim()
          || item.memberEmpName?.trim();
        if (!displayName) return [];
        const names = [item.memberEmpName, item.memberGroupNick, item.memberNick]
          .map((name) => name?.trim())
          .filter((name): name is string => Boolean(name));
        return [{
          displayName,
          names: [...new Set(names)],
          openDingTalkId: item.openDingtalkId?.trim(),
        }];
      });
      this.groups.set(groupId, { expiresAt: Date.now() + this.cacheTtlMs, members });
      return this.mergeObserved(groupId, members);
    } catch (error) {
      this.options.log?.warn?.(`[DingTalk members] group lookup failed for ${groupId}: ${String(error)}`);
      return this.mergeObserved(groupId, cached?.members ?? []);
    }
  }

  private mergeObserved(groupId: string, members: DingTalkDirectoryMember[]): DingTalkDirectoryMember[] {
    const merged = members.map((member) => ({ ...member, names: [...member.names] }));
    for (const observed of this.observed.get(groupId) ?? []) {
      const match = merged.find((member) =>
        (observed.openDingTalkId && member.openDingTalkId === observed.openDingTalkId)
        || member.names.some((name) => observed.names.includes(name))
      );
      if (match) {
        match.userId ??= observed.userId;
        match.names = [...new Set([...match.names, ...observed.names])];
      } else {
        merged.push({ ...observed, names: [...observed.names] });
      }
    }
    return merged;
  }

  private async resolveUserId(member: DingTalkDirectoryMember): Promise<void> {
    if (member.userId) return;
    const query = member.names.find((name) => /^[\u3400-\u9fff]{2,4}$/.test(name)) ?? member.displayName;
    try {
      const { stdout } = await execFileAsync(this.binary, [
        "contact", "user", "search",
        "--query", query,
        "--format", "json",
      ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      const parsed = JSON.parse(stdout) as {
        success?: boolean;
        result?: Array<{ name?: string; nick?: string; openDingTalkId?: string; userId?: string }>;
      };
      const match = parsed.result?.find((item) =>
        (member.openDingTalkId && item.openDingTalkId === member.openDingTalkId)
        || member.names.includes(item.name?.trim() ?? "")
        || member.names.includes(item.nick?.trim() ?? "")
      );
      member.userId = match?.userId?.trim();
    } catch (error) {
      this.options.log?.warn?.(`[DingTalk members] user lookup failed for ${member.displayName}: ${String(error)}`);
    }
  }
}
