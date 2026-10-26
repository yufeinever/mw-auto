import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const cdpConfigFile = path.join(os.homedir(), 'AppData/Local/Programs/MobileWork/resources/build-info.json');
export async function readCdpConfig(file = cdpConfigFile) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (typeof data.packagedCdpAllowed !== 'boolean') throw Error('missing flag');
    return { enabled: data.packagedCdpAllowed };
  } catch { throw Error('无法读取 MobileWork CDP 配置 build-info.json，请检查安装路径、文件权限及 packagedCdpAllowed 字段。'); }
}

// Change only the verified boolean field, retaining unrelated build metadata.
export async function ensureCdpConfig({ file = cdpConfigFile, running = false } = {}) {
  const { enabled } = await readCdpConfig(file);
  if (enabled) return { changed: false };
  const original = await fs.readFile(file, 'utf8');
  const matches = [...original.matchAll(/"packagedCdpAllowed"\s*:\s*false/g)];
  if (matches.length !== 1) throw Error('CDP 配置格式不明确，未修改；请检查 build-info.json。');
  const backup = `${file}.mw-auto-${randomUUID()}.bak`;
  try {
    await fs.writeFile(backup, original, { flag: 'wx' });
    await fs.writeFile(file, original.replace(/("packagedCdpAllowed"\s*:\s*)false/, '$1true'));
    if (!(await readCdpConfig(file)).enabled) throw Error('verify');
  } catch { throw Error('开启 CDP 失败，请检查 build-info.json 写入权限；未启动测试。'); }
  if (running) throw Error('CDP 已从 false 改为 true，需重启生效。请从托盘退出 MW，再点击“已从托盘退出，启动并执行”。未创建测试批次。');
  return { changed: true };
}
