import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

export function trustedRequest(req, port, token) {
  const h = req.headers || {};
  if (h.host !== `127.0.0.1:${port}`) return false;
  if (h.origin && h.origin !== `http://127.0.0.1:${port}`) return false;
  if (h['sec-fetch-site'] && !['same-origin','none'].includes(h['sec-fetch-site'])) return false;
  const actual = Buffer.from(String(h.authorization || ''));
  const expected = Buffer.from(`Bearer ${token}`);
  return token.length >= 16 && actual.length === expected.length && timingSafeEqual(actual, expected);
}
const READ = new Set(['help','deps','selftest','session','feed','search','video','subtitles','debrief','comments','comment-digest','likes','thread','check-comment','check-dynamic','check-mention','whois','recon','watch-video','covers']);
const ALL = new Set([...READ,'await','watch','comment-await','dm-await','ai-share','quota','diary','night','traffic','notify','fav','dm','comment','reply-draft','comment-del','dynamic','dynamic-image','dynamic-edit','danmaku']);
export function validateCommand(args, {manual=false, allowWrite=false}={}) {
  if (!Array.isArray(args) || !args.length || args.length > 40 || args.some(a => typeof a !== 'string' || a.length > 12000 || /[\0\r\n]/.test(a))) throw Error('Invalid command arguments');
  if (!ALL.has(args[0])) throw Error('Unsupported command');
  if (manual) return args;
  const isBV = value => /^BV[0-9A-Za-z]{10}$/.test(value || '');
  if (['debrief','subtitles','video','watch-video','comments','recon'].includes(args[0]) && !isBV(args[1])) throw Error('A real BV identifier is required');
  if (args[0] === 'covers' && (args.length < 2 || args.slice(1).some(a=>!isBV(a)))) throw Error('Covers require BV identifiers only');
  if (args[0] === 'watch-video') {
    const positional=[];
    for(let i=1;i<args.length;i++) {
      if(args[i]==='--tile') { i++; continue; }
      if(args[i].startsWith('--tile=') || args[i]==='--uniform') continue;
      if(args[i].startsWith('--')) throw Error('Unsupported video option');
      positional.push(args[i]);
    }
    if(positional.length>2 || (positional[1] && !['3x3','4x4'].includes(positional[1]))) throw Error('Custom output directories are manual-only');
  }
  if (['dynamic-edit','dynamic-image'].includes(args[0])) throw Error('File-based publishing is available only in the local manual panel');
  const safeState = (args[0] === 'quota' && args[1] === 'react' && args.includes('--auto')) || (args[0] === 'ai-share' && args[1] === 'sample') || (args[0] === 'quota' && ['status','check'].includes(args[1])) || (args[0] === 'diary' && ['show','tail'].includes(args[1])) || (args[0] === 'night' && args[1] === 'status') || (args[0] === 'traffic' && (!args[1] || args[1] === 'status')) || (args[0] === 'dm' && args.includes('--status')) || (args[0] === 'fav' && args.includes('--list'));
  const write = ['dm','comment','fav','reply-draft','dynamic','comment-del','dynamic-edit','danmaku'].includes(args[0]);
  if (!READ.has(args[0]) && !safeState && !(allowWrite && write)) throw Error('This operation needs owner approval');
  if (args.some(a=>/^--(?:out|output|path|dir|file|cookie|config|home|url|exec)(?:=|$)/i.test(a))) throw Error('Custom file paths are not available to the agent');
  return args;
}
export function redact(text, {root='', secrets=[]}={}) {
  let result=String(text);
  for(const secret of [...secrets,root].filter(Boolean).sort((a,b)=>b.length-a.length)) result=result.split(secret).join(secret===root?'{STATE}':'[redacted]');
  return result.slice(0,48000);
}
export function isolatedEnvironment(base, root, node) {
  return {...base, DSWHALE_DATA_HOME:root, DSH_HOME:path.join(root,'.dsh'), DSH_NODE:node, BILI_WHALE_CONFIG:path.join(root,'.dsh','bili-whale.config.json')};
}
