// 从官方 favicon.svg 生成 adaptive-icon 前景图。
// ★ 核心：官方是**一条 path 内 4 个子路径**，靠 nonzero 环绕方向挖空（眼睛/肚子/嘴）。
//   必须合并成**同一条 pathData**，否则拆开各自填充 = 实心块。
const fs = require('fs');
const path = require('path');

const root = __dirname;
const svg = fs.readFileSync(path.join(root, '_favicon.svg'), 'utf8');

// 抓所有 d="..." （可能有多条 <path>，全部合并）
const ds = [...svg.matchAll(/\sd="([^"]+)"/g)].map(m => m[1]);
if (!ds.length) throw new Error('no path data found');

console.log('source <path> count:', ds.length);
ds.forEach((d, i) => {
  const subs = (d.match(/[Mm]/g) || []).length;
  console.log(`  path[${i}] len=${d.length} subpaths=${subs} starts="${d.slice(0, 20)}"`);
});

// 合并成一条：以空格连接即可（M 会开启新子路径，nonzero 环绕规则继续生效）
const merged = ds.join(' ').replace(/\s+/g, ' ').trim();
console.log('merged len:', merged.length, 'total subpaths:', (merged.match(/[Mm]/g) || []).length);

const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- ★★ 2026-10-20：App 图标 = 官方鲸鱼（与启动页 ic_whale.xml 同源）。

     ★★★ 这里是**一条 path**，不是多条！
     官方原图靠 nonzero 环绕方向把「眼睛」「肚子」「嘴」挖成空白。
     拆成多条 path 各自填充 ⇒ 挖空失效 ⇒ 变成**实心白块**（本项目已踩过一次，
     真机截图确认过：只有一团白色鲸鱼轮廓，看不见眼睛和肚子）。
     ⇒ 4 个子路径必须写在**同一个 android:pathData** 里，由 M 分隔，fillType=nonZero。

     ★ 自适应图标安全区：108×108 图层会被系统裁成各种形状，实际可见区约中间 72×72。
       原图 50×50 → scale 1.32 = 66×66，偏移 (108-66)/2 = 21 ⇒ 居中且留 3px 余量。 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">

    <group
        android:translateX="21"
        android:translateY="21"
        android:scaleX="1.32"
        android:scaleY="1.32">

        <path
            android:fillColor="#FFFFFFFF"
            android:fillType="nonZero"
            android:pathData="${merged}" />
    </group>
</vector>
`;

const out = path.join(root, 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_launcher_foreground.xml');
fs.writeFileSync(out, xml, 'utf8');
console.log('written:', out, fs.statSync(out).size, 'bytes');
