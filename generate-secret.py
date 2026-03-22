from numpy import random
import base64

# Used to generate secret and token
# token should be 40
# secret should be 100

res = []

for _ in range(255):
  res.append(random.randint(255))

secret = base64.b64encode(bytearray(res)).decode("utf-8")

print(secret)