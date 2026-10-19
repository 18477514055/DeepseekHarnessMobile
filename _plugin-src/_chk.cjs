const fs=require('fs');
const t=fs.readFileSync('lib/client.js','utf8');
// 收集所有 function xxx( 定义
const defs=new Set();
(t.match(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)||[]).forEach(m=>{
  defs.add(m.replace(/function\s+/,'').replace(/\s*\($/,''));
});
console.log('定义的函数数:', defs.size);
// 收集所有被调用的 xxx(
const calls=new Set();
(t.match(/\b([A-Za-z_$][\w$]*)\s*\(/g)||[]).forEach(m=>{
  const n=m.replace(/\s*\($/,'');
  if(!/^(if|for|while|switch|catch|function|return|typeof|new|JSON|Object|Array|String|Number|Math|Date|console|document|window|parseInt|parseFloat|setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|encodeURIComponent|decodeURIComponent|isNaN|Promise|Error|RegExp|Boolean|Symbol|Map|Set|URL|AbortController|fetch|getComputedStyle|alert|confirm|prompt|localStorage|MutationObserver|KeyboardEvent|Event|CustomEvent|Node|Element|EventTarget|ResizeObserver|IntersectionObserver|performance|structuredClone|queueMicrotask)$/.test(n)) calls.add(n);
});
const missing=[...calls].filter(c=>!defs.has(c)).sort();
console.log('=== 可能未定义的调用 ===');
console.log(missing.join(', ')||'(无)');
