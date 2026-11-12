"""旧スプレッドシート（.xlsx）から、突き合わせ用の JSON を書き出す（手元専用）。
使い方: python3 -I tools/reconcile-extract.py private/2026.xlsx private/2026.json
出力には受講生の実名が入るので、private/ の外に置かないこと。
"""
import json
import sys

import openpyxl

SLOTS = ['月', '火1', '火2', '水1', '水2', '木1', '木2', '金1', '金2']
FOOTERS = ('補講等調整数', '欠席数')


def text(v):
    return None if v is None else str(v).strip() or None


def main(src, dst):
    vals = openpyxl.load_workbook(src, data_only=True)
    out = {'roster': [], 'groups': [], 'withdrawals': [], 'summary': {}, 'footer': {}}
    for slot in SLOTS:
        ws = vals[slot]
        ga = None
        for r in range(2, ws.max_row + 1):
            a = text(ws.cell(r, 1).value)
            if a and a.startswith(FOOTERS):
                key = '補講' if a.startswith('補講') else '欠席'
                # 備考列：H(8), K(11), M(13) … Y(25)
                out['footer'].setdefault(slot, {})[key] = [ws.cell(r, c).value or 0 for c in (8, 11, 13, 15, 17, 19, 21, 23, 25)]
                continue
            if a:
                ga = a
                out['groups'].append({'slot': slot, 'ga': ga, 'size': ws.cell(r, 2).value})
            name = text(ws.cell(r, 4).value)
            if not name or ga is None:
                continue
            cells = []
            # 第1回: G(7) 備考 H(8) クイズ I(9)／第2回以降: J(10),K(11) … X(24),Y(25)／最後のクイズ Z(26)
            cols = [(7, 8)] + [(10 + 2 * i, 11 + 2 * i) for i in range(8)]
            for i, (tc, nc) in enumerate(cols):
                cells.append({'round': i, 'typing': ws.cell(r, tc).value, 'note': text(ws.cell(r, nc).value)})
            out['roster'].append({
                'slot': slot, 'ga': ga, 'name': name, 'kana': text(ws.cell(r, 5).value), 'nickname': text(ws.cell(r, 6).value),
                'withdrawnMark': text(ws.cell(r, 3).value), 'quizFirst': ws.cell(r, 9).value, 'quizLast': ws.cell(r, 26).value, 'cells': cells,
            })
    ws = vals['解約・移動']
    for r in range(5, 55):
        name = text(ws.cell(r, 3).value)
        if name:
            out['withdrawals'].append({'round': ws.cell(r, 2).value, 'name': name, 'kana': text(ws.cell(r, 4).value), 'slot': text(ws.cell(r, 5).value), 'ga': text(ws.cell(r, 6).value), 'reason': text(ws.cell(r, 7).value)})
    s = out['summary']
    s['withdrawnBySlotRound'] = {SLOTS[i]: [ws.cell(6 + k, 29 + i).value or 0 for k in range(9)] for i in range(9)}
    s['finalBySlot'] = {SLOTS[i]: ws.cell(19 + i, 35).value for i in range(9)}
    s['finalTotal'] = ws.cell(28, 35).value
    s['initialBySlot'] = {SLOTS[i]: ws.cell(48 + i, 20).value for i in range(9)}
    s['initialTotal'] = ws.cell(57, 20).value
    s['retention'] = ws.cell(28, 41).value
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"roster {len(out['roster'])} / groups {len(out['groups'])} / withdrawals {len(out['withdrawals'])}")
    print('summary', {k: v for k, v in s.items() if 'By' not in k})


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
