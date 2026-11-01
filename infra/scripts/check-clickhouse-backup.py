#!/usr/bin/env python3
# CityHash portions: Copyright (c) 2011 Google, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.
"""Validate the standalone ClickHouse 26.10 native ZIP backup format.

The manifest and 2048-byte CityHash v1.0.2 chaining follow ClickHouse's
BackupImpl and HashingReadBuffer. This is not an authenticity check.
CityHash portions below are adapted from Google's CityHash (MIT license):
https://github.com/ClickHouse/ClickHouse/blob/v26.10.2.103-stable/contrib/cityhash102/src/city.cc
"""
import datetime
import re
import sys
import uuid
import xml.etree.ElementTree as ET
import zipfile

MASK = (1 << 64) - 1
K0 = 0xc3a5c85c97cb3127
K1 = 0xb492b66fbe98f273
K2 = 0x9ae16a3b2f90404f
K3 = 0xc949d7c7509e6557
KM = 0x9ddfea08eb382d69


def u(x):
    return x & MASK


def rot(x, n):
    x = u(x)
    return u((x >> n) | (x << (64 - n))) if n else x


def mix(x):
    x = u(x)
    return x ^ (x >> 47)


def h16(a, b):
    a = u((a ^ b) * KM)
    a ^= a >> 47
    b = u((b ^ a) * KM)
    b ^= b >> 47
    return u(b * KM)


def fetch(s, offset, n=8):
    return int.from_bytes(s[offset:offset + n], 'little')


def h0(s):
    n = len(s)
    if n > 8:
        a, b = fetch(s, 0), fetch(s, n - 8)
        return h16(a, rot(b + n, n)) ^ b
    if n >= 4:
        return h16(n + (fetch(s, 0, 4) << 3), fetch(s, n - 4, 4))
    if n:
        y = s[0] + (s[n >> 1] << 8)
        z = n + (s[n - 1] << 2)
        return u(mix(u(y * K2) ^ u(z * K3)) * K2)
    return K2


def weak(s, pos, a, b):
    w, x, y, z = (fetch(s, pos + i) for i in (0, 8, 16, 24))
    a = u(a + w)
    b = rot(b + a + z, 21)
    c = a
    a = u(a + x + y)
    return u(a + z), u(b + rot(a, 44) + c)


def city128(s, seed):
    n = len(s)
    a, b = seed
    if n < 128:
        if n <= 16:
            a = u(mix(u(a * K1)) * K1)
            c = u(b * K1 + h0(s))
            d = mix(a + (fetch(s, 0) if n >= 8 else c))
        else:
            c = h16(u(fetch(s, n - 8) + K1), a)
            d = h16(u(b + n), u(c + fetch(s, n - 16)))
            a = u(a + d)
            pos = 0
            remaining = n - 16
            while remaining > 0:
                a = u((a ^ u(mix(u(fetch(s, pos) * K1)) * K1)) * K1)
                b ^= a
                c = u((c ^ u(mix(u(fetch(s, pos + 8) * K1)) * K1)) * K1)
                d ^= c
                pos += 16
                remaining -= 16
        a, b = h16(a, c), h16(d, b)
        return a ^ b, h16(b, a)
    x, y = a, b
    z = u(n * K1)
    v = (u(rot(y ^ K1, 49) * K1 + fetch(s, 0)), 0)
    v = (v[0], u(rot(v[0], 42) * K1 + fetch(s, 8)))
    w = (u(rot(y + z, 35) * K1 + x), u(rot(x + fetch(s, 88), 53) * K1))
    pos = 0
    remaining = n
    while remaining >= 128:
        for _ in range(2):
            x = u(rot(x + y + v[0] + fetch(s, pos + 16), 37) * K1)
            y = u(rot(y + v[1] + fetch(s, pos + 48), 42) * K1)
            x ^= w[1]
            y ^= v[0]
            z = rot(z ^ w[0], 33)
            v = weak(s, pos, u(v[1] * K1), u(x + w[0]))
            w = weak(s, pos + 32, u(z + w[1]), y)
            z, x = x, z
            pos += 64
        remaining -= 128
    y = u(y + rot(w[0], 37) * K0 + z)
    x = u(x + rot(v[0] + z, 49) * K0)
    tail = 0
    while tail < remaining:
        tail += 32
        y = u(rot(y - x, 42) * K0 + v[1])
        w = (u(w[0] + fetch(s, pos + remaining - tail + 16)), w[1])
        x = u(rot(x, 49) * K0 + w[0])
        w = (u(w[0] + v[0]), w[1])
        v = weak(s, pos + remaining - tail, v[0], v[1])
    x, y = h16(x, v[0]), h16(y, w[0])
    return u(h16(u(x + v[1]), w[1]) + y), h16(u(x + w[1]), u(y + v[1]))


def checksum(stream):
    state = (0, 0)
    while block := stream.read(2048):
        state = city128(block, state)
    return f'{state[1]:016x}{state[0]:016x}'


def one(parent, name, required=True) -> str:
    found = parent.findall(name)
    if len(found) != 1 or len(found[0]) or found[0].text is None:
        if not found and not required:
            return ''
        raise ValueError(f'invalid {name}')
    value = found[0].text
    assert value is not None
    return value


def path_ok(name):
    return bool(name) and not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/'))


def validate(path):
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        if len(names) != len(set(names)) or any(not path_ok(n) for n in names):
            raise ValueError('duplicate or unsafe ZIP entry')
        manifest_info = z.getinfo('.backup')
        # Backups with millions of files can legitimately have large manifests.
        with z.open(manifest_info) as stream:
            root = ET.parse(stream).getroot()
        if root.tag != 'config' or one(root, 'version') != '1':
            raise ValueError('unsupported native backup version')
        header_fields = {'version', 'deduplicate_files', 'timestamp', 'uuid', 'backup_id', 'contents'}
        if any(child.tag not in header_fields for child in root):
            raise ValueError('unsupported native backup feature')
        for field in ('deduplicate_files', 'backup_id'):
            one(root, field, False)
        dedup = one(root, 'deduplicate_files', False)
        if dedup and dedup not in ('0', '1', 'true', 'false'):
            raise ValueError('invalid native deduplication flag')
        datetime.datetime.strptime(one(root, 'timestamp'), '%Y-%m-%d %H:%M:%S')
        uuid.UUID(one(root, 'uuid'))
        contents = root.findall('contents')
        if len(contents) != 1 or not len(contents[0]):
            raise ValueError('native backup contents missing')
        seen, used, data_files = set(), {'.backup'}, {}
        for entry in contents[0]:
            if entry.tag != 'file':
                raise ValueError('unsupported native backup entry')
            if any(child.tag not in {'name', 'size', 'checksum', 'data_file'} for child in entry):
                raise ValueError('unsupported native backup entry feature')
            name = one(entry, 'name')
            size_text = one(entry, 'size')
            if not path_ok(name) or name in seen or not re.fullmatch(r'[0-9]+', size_text):
                raise ValueError('invalid native file entry')
            seen.add(name)
            size = int(size_text)
            if size > (1 << 64) - 1:
                raise ValueError('native file size exceeds UInt64')
            if re.fullmatch(r'metadata/[^/]+\.sql', name) and not size:
                raise ValueError('native database metadata is empty')
            if not size:
                if name in names:
                    if z.getinfo(name).file_size != 0:
                        raise ValueError('native empty file has data')
                    used.add(name)
                continue
            expected = one(entry, 'checksum')
            if not re.fullmatch(r'[0-9a-f]{32}', expected):
                raise ValueError('invalid native checksum')
            data_file = one(entry, 'data_file', False) or name
            if not path_ok(data_file):
                raise ValueError('invalid native data file path')
            if data_file in data_files and data_files[data_file] != (size, expected):
                raise ValueError('conflicting native data file references')
            data_files[data_file] = (size, expected)
        if not any(re.fullmatch(r'metadata/[^/]+\.sql', n) for n in seen):
            raise ValueError('native database metadata missing')
        for name, (size, expected) in data_files.items():
            info = z.getinfo(name)
            if info.file_size != size:
                raise ValueError('native data file size mismatch')
            with z.open(info) as stream:
                if checksum(stream) != expected:
                    raise ValueError('native data file checksum mismatch')
            used.add(name)
        if set(names) != used:
            raise ValueError('ZIP has unreferenced entries')


if __name__ == '__main__':
    try:
        validate(sys.argv[1])
    except (ValueError, KeyError, OSError, EOFError, zipfile.BadZipFile, ET.ParseError) as error:
        raise SystemExit(f'Refusing restore: ClickHouse native backup validation failed: {error}')
