"""Render portable table/formula/card examples without a browser or font downloads."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def render(output, font_path):
    output.mkdir(parents=True, exist_ok=True)
    def font(size):
        return ImageFont.truetype(font_path, size)
    def base(title, subtitle, height=720):
        image = Image.new("RGB", (1080, height), "#ffffff")
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 1080, 12), fill="#168766")
        draw.text((58, 50), title, font=font(45), fill="#202329")
        draw.text((60, 118), subtitle, font=font(25), fill="#69727c")
        return image, draw

    image, draw = base("表格 · 图片渲染", "示例数据 / 非原生 Markdown 表格")
    columns = [60, 450, 690, 910, 1020]
    rows = [("消息格式", "展示方式", "点击交互", "示例"),
            ("Markdown", "原生文本", "支持链接", "A"),
            ("数学公式", "渲染为图片", "不可编辑", "B"),
            ("交互按钮", "原生键盘", "跳转 / 指令", "C"),
            ("图片卡片", "图片 + 说明", "独立按钮", "D")]
    for index, row in enumerate(rows):
        top = 200 + index * 78
        draw.rectangle((60, top, 1020, top + 77), fill="#e9f4ee" if index == 0 else ("#f5f7f9" if index % 2 else "#ffffff"))
        for column, text in enumerate(row):
            draw.text((columns[column] + 15, top + 23), text, font=font(25), fill="#202329")
        draw.line((60, top + 78, 1020, top + 78), fill="#d8dee4", width=1)
    image.save(output / "table.png")

    image, draw = base("公式 · 图片排版", "公式为图片内容，不依赖 QQ 内置 LaTeX")
    draw.text((80, 220), "E = mc", font=font(74), fill="#202329")
    draw.text((338, 203), "2", font=font(42), fill="#202329")
    draw.text((80, 366), "x =", font=font(60), fill="#202329")
    draw.text((247, 325), "-b ± √(b² - 4ac)", font=font(52), fill="#202329")
    draw.line((240, 400, 785, 400), fill="#202329", width=3)
    draw.text((464, 422), "2a", font=font(54), fill="#202329")
    draw.text((80, 590), "一元二次方程求根公式", font=font(30), fill="#168766")
    image.save(output / "formula.png")

    image, draw = base("R2-D2 · 今日简报", "图片卡片示例 / 以下均为演示数据", 780)
    draw.rectangle((60, 196, 1020, 304), fill="#eaf3fa")
    draw.text((90, 223), "运行状态：正常", font=font(36), fill="#1768a6")
    draw.text((90, 354), "09:00   更新消息样式", font=font(31), fill="#202329")
    draw.text((90, 424), "10:00   核对表格和公式效果", font=font(31), fill="#202329")
    draw.text((90, 494), "11:00   选择喜欢的展示方式", font=font(31), fill="#202329")
    draw.line((60, 594, 1020, 594), fill="#d8dee4", width=2)
    draw.text((90, 636), "文字 + 图片 + 交互入口", font=font(34), fill="#168766")
    image.save(output / "card.png")

    frames = []
    for index, color in enumerate(["#168766", "#1768a6", "#9b396b"]):
        frame = Image.new("RGB", (600, 300), "#ffffff")
        draw = ImageDraw.Draw(frame)
        draw.rectangle((0, 0, 600, 8), fill=color)
        draw.text((48, 55), "R2-D2 · 动图示例", font=font(35), fill="#202329")
        draw.text((48, 145), ["接收消息", "生成回复", "发送完成"][index], font=font(45), fill=color)
        frames.append(frame)
    frames[0].save(output / "animation.gif", save_all=True, append_images=frames[1:], duration=850, loop=0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--font", default="/System/Library/Fonts/STHeiti Medium.ttc")
    args = parser.parse_args()
    render(args.output, args.font)
