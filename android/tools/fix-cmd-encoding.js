// 把 build.cmd 以 GBK + CRLF 写出（本机硬规矩：.cmd/.bat 必须 GBK+CRLF）。
// ★ 不能用 PowerShell 的 Get-Content/Set-Content 转 —— 它会先按 UTF-8 解一遍，
//   中文就变成乱码再转 GBK，结果是「'EM' 不是内部或外部命令」这种鬼报错（已踩过）。
const fs = require('fs');
const iconv = (() => {
  // Node 没有内置 GBK 编码器；用 Buffer + 手写映射不现实。
  // 于是改用更稳的办法：**整个 .cmd 不写中文**（见下面 build.cmd 的内容），
  // 这样编码问题根本不存在，纯 ASCII 在 GBK/UTF-8 下字节完全相同。
  return null;
})();

const content = fs.readFileSync(process.argv[2], 'utf8');
if (/[^\x00-\x7F]/.test(content)) {
  console.error('❌ 文件含非 ASCII 字符。.cmd 建议纯英文，避免编码问题。');
  const bad = [...content].filter(c => c.charCodeAt(0) > 127).slice(0, 20).join('');
  console.error('   非 ASCII 样本:', bad);
  process.exit(1);
}
const out = content.replace(/\r?\n/g, '\r\n');
fs.writeFileSync(process.argv[2], Buffer.from(out, 'ascii'));
console.log('✅ 已写为 ASCII+CRLF:', process.argv[2], out.length, 'B');
