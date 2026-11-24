"""Convert .glb (binary glTF) to self-contained glTF JSON (buffers as base64 data URIs).
Static hosts that only serve web types (like claude.ai artifacts) can serve it as *.gltf.json; three's GLTFLoader reads it unchanged.
Usage: python tools/glb_to_gltf_json.py game/assets/props.glb  -> game/assets/props.gltf.json"""
import base64, json, struct, sys
for path in sys.argv[1:]:
    data = open(path, 'rb').read()
    magic, version, length = struct.unpack_from('<4sII', data, 0); assert magic == b'glTF', path
    off, js, binc = 12, None, b''
    while off < length:
        clen, ctype = struct.unpack_from('<I4s', data, off); chunk = data[off + 8: off + 8 + clen]; off += 8 + clen
        if ctype == b'JSON': js = json.loads(chunk)
        elif ctype == b'BIN\x00': binc = chunk
    js['buffers'][0]['uri'] = 'data:application/octet-stream;base64,' + base64.b64encode(binc).decode()
    out = path[:-4] + '.gltf.json'; json.dump(js, open(out, 'w'), separators=(',', ':')); print(out)
