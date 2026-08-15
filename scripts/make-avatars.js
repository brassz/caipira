const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'public', 'assets', 'avatars');
fs.mkdirSync(dir, { recursive: true });
const bgs = ['#1a4a8c', '#0d6b4f', '#6b1d4a', '#3b2a78', '#8a4a12', '#155a6e', '#4a1a6e', '#1a5a38', '#7a2a2a', '#2a4a7a', '#5a3a12', '#124a5a'];
const skins = ['#f3c7a5', '#e8b896', '#d4a574', '#c68642', '#8d5524', '#f6d3b8', '#e0a878', '#b8733a', '#f0c8a0', '#c9956a', '#aa7744', '#f5d0b0'];
const hairs = ['#1a120c', '#3a2414', '#6b4a1a', '#111111', '#4a2030', '#2c4a6e', '#8a6a2a', '#222222', '#5a3210', '#1a2a4a', '#4a1818', '#2a1a10'];
function svg(i) {
  const bg = bgs[i - 1], sk = skins[i - 1], hr = hairs[i - 1];
  const glasses = i % 3 === 0;
  const beard = i % 4 === 0;
  const pony = i % 5 === 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
<defs><linearGradient id="g${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#061018"/></linearGradient></defs>
<rect width="80" height="80" rx="40" fill="url(#g${i})"/>
${pony ? `<ellipse cx="40" cy="58" rx="10" ry="18" fill="${hr}"/>` : ''}
<ellipse cx="40" cy="72" rx="22" ry="14" fill="#1a2433"/>
<circle cx="40" cy="36" r="18" fill="${sk}"/>
<path d="M22 32 Q40 8 58 32" fill="${hr}"/>
<circle cx="33" cy="36" r="2.2" fill="#1a1a1a"/>
<circle cx="47" cy="36" r="2.2" fill="#1a1a1a"/>
<path d="M34 46 Q40 50 46 46" stroke="#a86" fill="none" stroke-width="1.6" stroke-linecap="round"/>
${glasses ? `<rect x="26" y="32" width="12" height="8" rx="2" fill="none" stroke="#d7e6ff" stroke-width="1.6"/><rect x="42" y="32" width="12" height="8" rx="2" fill="none" stroke="#d7e6ff" stroke-width="1.6"/><path d="M38 36 H42" stroke="#d7e6ff" stroke-width="1.4"/>` : ''}
${beard ? `<path d="M28 44 Q40 62 52 44 Q40 50 28 44" fill="${hr}" opacity=".85"/>` : ''}
</svg>`;
}
for (let i = 1; i <= 12; i++) {
  fs.writeFileSync(path.join(dir, String(i).padStart(2, '0') + '.svg'), svg(i));
}
console.log('avatars', fs.readdirSync(dir).length);
