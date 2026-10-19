const fs=require('fs');
const t=fs.readFileSync('lib/client.js','utf8');
console.log('lines', t.split('\n').length);
console.log('popupItem 处理:', t.includes('hit: "popupItem"'));
console.log('bottomZone 守卫:', t.includes('why: "bottomZone"'));
console.log('几何判据:', t.includes('er.top > vh * 0.55'));
