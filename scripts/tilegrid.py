import sys
from PIL import Image, ImageDraw
src, out = sys.argv[1], sys.argv[2]
T, S = 16, 3
im = Image.open(src).convert('RGBA')
W, H = im.size
big = im.resize((W*S, H*S), Image.NEAREST).convert('RGBA')
d = ImageDraw.Draw(big)
cols, rows = W//T, H//T
for c in range(cols+1):
    d.line([(c*T*S, 0), (c*T*S, H*S)], fill=(255, 40, 40, 160))
for r in range(rows+1):
    d.line([(0, r*T*S), (W*S, r*T*S)], fill=(255, 40, 40, 160))
for c in range(0, cols, 2):
    d.text((c*T*S+2, 2), str(c), fill=(255, 255, 0, 255))
for r in range(0, rows, 2):
    d.text((2, r*T*S+2), str(r), fill=(0, 255, 255, 255))
big.save(out)
print('saved', out, big.size, 'grid', cols, 'x', rows)
