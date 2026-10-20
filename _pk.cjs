const fs=require('fs'),path=require('path'),zlib=require('zlib');
const SRC='_plugin-src';
const OUT='android/app/src/main/assets/mobile-adapt.gz.bin';
const ALLOW=['lib','package.json','cordis.patch.yml','README.md','android-bridge'];
const entries=[{name:'plugin-src/',mode:0o755,data:null}];
function walk(abs, rel){
  const st=fs.lstatSync(abs);
  if(st.isDirectory()){
    entries.push({name:rel+'/',mode:0o755,data:null});
    for(const n of fs.readdirSync(abs).sort()) walk(path.join(abs,n), rel+'/'+n);
  } else entries.push({name:rel,mode:0o644,data:fs.readFileSync(abs)});
}
for(const a of ALLOW) walk(path.join(SRC,a),'plugin-src/'+a);
function hdr(name,mode,size,type){
  const h=Buffer.alloc(512);
  h.write(name.slice(0,99),0,99,'utf8');
  const oct=(n,len)=>'0'.repeat(Math.max(0,len-1-n.toString(8).length))+n.toString(8)+'\0';
  h.write(oct(mode,8),100,'ascii'); h.write(oct(0,8),108,'ascii'); h.write(oct(0,8),116,'ascii');
  h.write(oct(size,12),124,'ascii'); h.write(oct(0,12),136,'ascii');
  h.write('        ',148,'ascii'); h.write(type,156,'ascii');
  h.write('ustar\0',257,'ascii'); h.write('00',263,'ascii');
  h.write('root',265,'ascii'); h.write('root',297,'ascii');
  let sum=0; for(let i=0;i<512;i++)sum+=h[i];
  h.write(sum.toString(8).padStart(6,'0')+'\0 ',148,'ascii');
  return h;
}
const chunks=[];
for(const e of entries){
  if(e.data===null) chunks.push(hdr(e.name,e.mode,0,'5'));
  else{
    chunks.push(hdr(e.name,e.mode,e.data.length,'0'), e.data);
    const pad=(512-(e.data.length%512))%512; if(pad) chunks.push(Buffer.alloc(pad));
  }
}
chunks.push(Buffer.alloc(1024));
const gz=zlib.gzipSync(Buffer.concat(chunks),{level:9});
fs.writeFileSync(OUT,gz);
console.log('gz',gz.length,'B');
