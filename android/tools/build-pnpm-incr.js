const fs=require('fs'),path=require('path'),zlib=require('zlib');
const PKG='_pnpmfix/pnpm-pkg/package';
const NATIVE='_pnpmfix/package/pnpm';
const OUT='_pnpmfix/pnpm-incr-new.gz';

const entries=[];   // {name, mode, data|null for dir}
function walk(abs, rel){
  const st=fs.lstatSync(abs);
  if(st.isDirectory()){
    entries.push({name:rel+'/',mode:0o755,data:null});
    for(const n of fs.readdirSync(abs).sort())
      walk(path.join(abs,n), rel+'/'+n);
  } else if(st.isSymbolicLink()){
    console.log('!! symlink found:',rel,'->',fs.readlinkSync(abs));
  } else {
    // bin/ 下的 .mjs 与占位脚本给 +x；其余 644
    const isBin = /(^|\/)(bin\/.*|pn|pnpm|pnpx|pnx|install)$/.test(rel) && !rel.endsWith('.md');
    const mode = isBin ? 0o755 : 0o644;
    entries.push({name:rel,mode,data:fs.readFileSync(abs)});
  }
}
walk(PKG,'pnpm');

// 放真二进制（覆盖/新建）
const native=fs.readFileSync(NATIVE);
const rel='pnpm/node_modules/@pnpm/exe.linux-arm64/pnpm';
// 确保中间目录条目存在
for(const d of ['pnpm/node_modules/','pnpm/node_modules/@pnpm/','pnpm/node_modules/@pnpm/exe.linux-arm64/']){
  if(!entries.some(e=>e.name===d)) entries.push({name:d,mode:0o755,data:null});
}
entries.push({name:rel,mode:0o755,data:native});
console.log('entries:',entries.length,'native:',native.length);

// ---- tar 写入 ----
function hdr(name,mode,size,type){
  const h=Buffer.alloc(512);
  h.write(name.slice(0,99),0,99,'utf8');
  const oct=(n,len)=>'0'.repeat(Math.max(0,len-1-n.toString(8).length))+n.toString(8)+'\0';
  h.write(oct(mode,8),100,'ascii');
  h.write(oct(0,8),108,'ascii');
  h.write(oct(0,8),116,'ascii');
  h.write(oct(size,12),124,'ascii');
  h.write(oct(0,12),136,'ascii');
  h.write('        ',148,'ascii');
  h.write(type,156,'ascii');
  h.write('ustar\0',257,'ascii');
  h.write('00',263,'ascii');
  h.write('root',265,'ascii');
  h.write('root',297,'ascii');
  let sum=0; for(let i=0;i<512;i++)sum+=h[i];
  h.write(sum.toString(8).padStart(6,'0')+'\0 ',148,'ascii');
  return h;
}
const chunks=[];
for(const e of entries){
  if(e.data===null){
    chunks.push(hdr(e.name,e.mode,0,'5'));
  } else {
    chunks.push(hdr(e.name,e.mode,e.data.length,'0'), e.data);
    const pad=(512-(e.data.length%512))%512;
    if(pad)chunks.push(Buffer.alloc(pad));
  }
}
chunks.push(Buffer.alloc(1024));
const tar=Buffer.concat(chunks);
const gz=zlib.gzipSync(tar,{level:9});
fs.writeFileSync(OUT,gz);
console.log('tar',tar.length,'-> gz',gz.length,'(',(gz.length/1048576).toFixed(1),'MB )');
