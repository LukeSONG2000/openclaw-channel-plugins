# QQBot Group Permissions

`channels.qqbot.customRuntime.groupPermissions` defines one of three group modes:

- `free`: receives full group context and enables adaptive unread polling replies.
- `admin`: management-group behavior; autonomous polling is disabled.
- `default`: replies only when mentioned or quoted; unread polling is disabled.

New and otherwise unbound groups should use `default`:

```json
{
  "channels": {
    "qqbot": {
      "customRuntime": {
        "groupPermissions": {
          "default": "default",
          "bindings": {
            "qqbot:group:FREE_GROUP_OPENID": "free",
            "qqbot:group:ADMIN_GROUP_OPENID": "admin"
          }
        }
      }
    }
  }
}
```

The configured `customRuntime.adminGroup` is always resolved as `admin`, even if
its explicit binding is missing. Raw `group_openid` keys are also accepted.
