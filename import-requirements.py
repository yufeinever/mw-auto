import json, zipfile, xml.etree.ElementTree as ET
from pathlib import Path

source = Path.home() / 'Downloads' / 'MobileWork性能需求.xlsx'
ns = {'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(source) as z:
    strings = [''.join(t.itertext()) for t in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si',ns)]
    rows = ET.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('s:sheetData/s:row',ns)
    result=[]
    groups=[(11,'首页'),(18,'新建任务'),(26,'历史任务'),(31,'专家'),(37,'技能'),(39,'工具'),(45,'案例库'),(47,'自动化')]
    for row in rows:
        i=int(row.attrib['r'])
        if not 4 <= i <= 47: continue
        cells={}
        for c in row.findall('s:c',ns):
            v=c.findtext('s:v','',ns)
            if c.attrib.get('t')=='s' and v: v=strings[int(v)]
            cells[''.join(x for x in c.attrib['r'] if x.isalpha())]=v
        def seconds(key):
            try: return float(cells.get(key,''))
            except ValueError: return None
        result.append(dict(id=f'MW-UI-{i:03}',row=i,module=next(g for end,g in groups if i<=end),name=cells.get('C',''),target=cells.get('D',''),sourceDescription=cells.get('E',''),coldSeconds=seconds('G'),hotSeconds=seconds('H'),sourceSheet='界面相应时间',script=f'cases/MW-UI-{i:03}.mjs'))
Path(__file__).with_name('data').joinpath('cases.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
for case in result:
    Path(__file__).with_name('cases').joinpath(case['id']+'.mjs').write_text("import { execute } from '../lib/actions.mjs';\nexport default ctx => execute("+str(case['row'])+", ctx);\n",encoding='utf-8')
print('Imported',len(result),'cases, original workbook unchanged.')
