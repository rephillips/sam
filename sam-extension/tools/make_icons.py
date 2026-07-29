"""
Generate SAM extension icons.

An original chevron mark — a nod to the angle-bracket motif common to Splunk
tooling — drawn from scratch. This is deliberately NOT a reproduction of the
Splunk wordmark or any trademarked asset. Swap in an official brand asset here
if this is ever distributed internally under Splunk branding.
"""

from PIL import Image, ImageDraw

SS = 8  # supersample factor for smooth edges
BG_TOP = (22, 30, 43)
BG_BOT = (11, 15, 22)
# Match the design-system accent: chevron = --accent / --green-500,
# underscore = --accent-press / --green-600. Keep in sync with tokens.css.
ACCENT = (39, 201, 135)
ACCENT_DIM = (32, 168, 111)


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def make_icon(px):
    size = px * SS
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # vertical gradient background
    bg = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(bg)
    for y in range(size):
        t = y / max(size - 1, 1)
        d.line(
            [(0, y), (size, y)],
            fill=(
                int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t),
                int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t),
                int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t),
                255,
            ),
        )
    img.paste(bg, (0, 0), rounded_mask(size, int(size * 0.22)))

    draw = ImageDraw.Draw(img)
    w = int(size * 0.115)  # stroke width

    # Chevron: left edge -> apex -> back down
    x0, x1 = size * 0.30, size * 0.60
    y0, y1 = size * 0.28, size * 0.72
    ymid = size * 0.50
    draw.line([(x0, y0), (x1, ymid), (x0, y1)], fill=ACCENT, width=w, joint="curve")
    for pt in [(x0, y0), (x1, ymid), (x0, y1)]:
        draw.ellipse([pt[0] - w / 2, pt[1] - w / 2, pt[0] + w / 2, pt[1] + w / 2], fill=ACCENT)

    # Underscore/baseline accent to the right of the chevron
    bx0, bx1 = size * 0.64, size * 0.76
    by = size * 0.72
    draw.line([(bx0, by), (bx1, by)], fill=ACCENT_DIM, width=w, joint="curve")
    for pt in [(bx0, by), (bx1, by)]:
        draw.ellipse([pt[0] - w / 2, pt[1] - w / 2, pt[0] + w / 2, pt[1] + w / 2], fill=ACCENT_DIM)

    return img.resize((px, px), Image.LANCZOS)


if __name__ == "__main__":
    import os

    os.makedirs("icons", exist_ok=True)
    for px in (16, 32, 48, 128):
        make_icon(px).save(f"icons/icon{px}.png")
        print(f"icons/icon{px}.png")
