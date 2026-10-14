import { scenario as s, pause, screen, keys, command, esc, prompt, until, settle, legacyClientFallback } from './helpers.mjs';

const modelSelector = () => [{ text: '/model' }, keys('Enter'), until('set as default'), settle()];
const inspectPreferences = name => [
  ...command(`!!node -e 'const f=require("node:fs"),c=require("node:crypto"),a=process.env.FELAN_AGENT_DIR,p=f.existsSync(a+"/../client/settings.json")?a+"/../client":a;for(const [label,dir] of [["AGENT",a],["CLIENT",p]]){const s=f.readFileSync(dir+"/settings.json"),v=JSON.parse(s);console.log(label,"SHA256",c.createHash("sha256").update(s).digest("hex"));console.log(label,"MTIME",f.statSync(dir+"/settings.json").mtimeMs,"CURSOR",v.showHardwareCursor,"RESTORE",v.extensionConfig?.prewalk?.restorePlanner);}const t=p+"/tui/settings.json";console.log("TUI EXISTS",f.existsSync(t));if(f.existsSync(t)){const u=JSON.parse(f.readFileSync(t));console.log("TUI CURSOR",u.hardwareCursor);console.log("TUI DISPLAY",JSON.stringify({askUser:u.presentation?.askUser,tasks:u.presentation?.tasks,promptHistory:u.presentation?.promptHistory}));}'`),
  screen(name),
];
const settingsSection = (name, filter, newFilter = filter) => [
  ...command('/settings', 'General'),
  { side: 'old', text: filter }, { side: 'new', text: newFilter }, pause(), keys('Enter'), pause(), screen(name),
  ...esc(), ...esc(),
];
// Twelve pre-daemon Pi transcripts in the workspace's per-cwd session directory: varied ages, one name and one without messages.
// The daemon lists them as unregistered legacy sessions; 0.28.3 lists them natively. Avoid backslashes: the text is typed into the editor.
const seedSessions = () => command(`!!node -e 'const f=require("node:fs"),p=require("node:path"),c=process.cwd(),n=String.fromCharCode(10),d=p.join(process.env.FELAN_AGENT_DIR,"sessions","--"+c.slice(1).split("/").join("-")+"--");f.mkdirSync(d,{recursive:true,mode:448});const t=["Fix the flaky login test","Add dark mode to the settings page","","Explain the release checklist","Refactor the payment module","Write docs for the CLI flags","Investigate slow startup","Upgrade the build to Node 22","Review the API error handling","Plan the database migration","Clean up unused dependencies","Draft the changelog"],a=[2,40,90,180,600,1500,3000,5000,12000,30000,60000,200000];t.forEach((m,i)=>{const at=Date.now()-a[i]*60000,ts=new Date(at).toISOString(),id="01900000-0000-7000-8000-0000000000"+String(i).padStart(2,"0"),r=[{type:"session",version:3,id,timestamp:ts,cwd:c}];if(m)r.push({type:"message",id:"u"+i,parentId:null,timestamp:ts,message:{role:"user",content:m,timestamp:at}});if(i===3)r.push({type:"session_info",id:"n"+i,parentId:"u"+i,timestamp:ts,name:"Release plan"});const file=p.join(d,ts.replace(/[:.]/g,"-")+"_"+id+".jsonl");f.writeFileSync(file,r.map(x=>JSON.stringify(x)).join(n)+n,{mode:384});f.utimesSync(file,at/1000,at/1000)});console.log("PARITY SESSIONS SEEDED")'`, 'PARITY SESSIONS SEEDED');
export default [
  s('B-model', 'Session and default model choice', [...modelSelector(), screen('selector'), keys('Enter'), pause(), screen('enter-choice'), ...modelSelector(), keys('Down'), keys('C-s'), pause(), screen('ctrl-s-choice'), ...esc()], ['selector', 'session vs default wording', 'footer model']),
  s('B-thinking', 'Thinking options', [...command('/thinking', 'Thinking'), screen('options'), keys('Up'), keys('Enter'), pause(), screen('selected'), ...command('/thinking', 'Thinking'), screen('reopened'), keys('Up'), keys('C-s'), pause(), screen('default-selected'), ...esc()], ['options', 'current value', 'footer update', 'session versus default save']),
  s('B-settings', 'Settings ownership and effective values', [
    ...legacyClientFallback(),
    ...inspectPreferences('files-before'),
    ...command('/settings', 'General'), screen('settings'), keys('Enter'), pause(), screen('general'),
    keys(...Array(10).fill('Down')), pause(), screen('general-page-2'), keys(...Array(10).fill('Down')), pause(), screen('general-page-3'),
    keys(...Array(10).fill('Down')), pause(), screen('general-page-4'),
    { text: 'cursor' }, pause(), screen('matched-setting'), keys('Enter'), pause(), screen('changed'), ...esc(), ...esc(),
    ...inspectPreferences('files-after-display'),
    ...command('/settings', 'General'), screen('reopened'), keys('Enter'), pause(), screen('reopened-general'), { text: 'cursor' }, pause(), screen('persisted-setting'), ...esc(), ...esc(),
    ...settingsSection('ask-user-settings', 'Ask User', 'Ask User display'),
    ...settingsSection('tasks-settings', 'Tasks', 'Tasks display'),
    ...settingsSection('history-settings', 'Prompt History', 'Prompt History display'),
    ...settingsSection('powerline-settings', 'Powerline', 'Powerline display'),
    ...command('/settings', 'General'), { text: 'Prewalk' }, pause(), keys('Enter'), pause(), screen('behaviour-before'),
    { text: 'restore' }, pause(), keys('Enter'), pause(), screen('behaviour-changed'), ...esc(), ...esc(),
    ...settingsSection('behaviour-persisted', 'Prewalk'), ...inspectPreferences('files-after-behaviour'),
  ], ['general and extension effective values', 'display and behaviour save persistence', 'sandbox legacy digest and mtime unchanged by display toggle', 'client-local tui/settings.json'], ['Display sections are client-owned on new; execution settings remain daemon-owned.']),
  s('B-login-nav', 'Login navigation without authentication', [...command('/login', 'authentication method'), screen('methods'), keys('Enter'), until('Select provider'), pause(), screen('providers'), keys('Down'), pause(), screen('provider-selection'), { text: 'codex' }, pause(), screen('filtered'), ...esc(), screen('back'), ...esc(), screen('cancelled'), { blocked: 'Provider drill-down is not automated: it may launch OAuth or access the keychain. Navigation was captured; complete drill-down only under human control.' }], ['type-first order', 'filtering', 'back and cancel'], ['Do not press Enter on a provider: OAuth could open a browser or access the keychain; authentication drill-down requires a human-controlled run.']),
  s('B-logout-nav', 'Logout list and cancel', [...command('/logout', 'provider'), screen('accounts'), ...esc(), screen('cancelled')], ['account list', 'cancel behaviour']),
  s('B-sessions', 'New, resume, rename and fork', [...command('/new'), screen('new'), ...prompt('say hi', 'seed-response'), { side: 'old', text: '/resume' }, { side: 'new', text: '/sessions' }, keys('Enter'), until('Session'), pause(), screen('sessions'), keys('Tab'), pause(), screen('all-scope'), keys('C-s'), pause(), screen('sort'), keys('C-n'), pause(), screen('named'), keys('C-n'), keys('C-p'), pause(), screen('paths'), ...esc(), keys('C-u'), { side: 'old', text: '/name parity' }, { side: 'new', text: '/rename parity' }, keys('Enter'), pause(), screen('renamed'), ...command('/fork'), screen('fork')], ['session list', 'names', 'scope', 'sort', 'named filter', 'paths', 'fork notice'], ['/resume and /name on old, /sessions and /rename on new', 'model prose'], true),
  s('B-resume', 'Resume picker with more sessions than fit', [
    ...seedSessions(), screen('seeded'),
    ...command('/resume', 'Resume Session'), screen('list'),
    keys(...Array(6).fill('Down')), pause(), screen('down-6'), keys(...Array(6).fill('Down')), pause(), screen('bottom'),
    keys(...Array(5).fill('Up')), pause(), screen('up-5'),
    keys('Tab'), pause(), screen('all-scope'), keys('C-p'), pause(), screen('paths'), keys('C-p'), keys('Tab'), pause(),
    { resize: [120, 24] }, pause(), screen('short-terminal'), keys(...Array(8).fill('Down')), pause(), screen('short-scrolled'),
    { resize: [120, 40] }, pause(), screen('restored'), ...esc(), screen('closed'),
  ], ['stable row count while scrolling', 'counter visibility', 'first-message labels', 'age metadata', 'folder only in All scope', 'short terminal fit'],
  ['message counts are 0.28.3-only: daemon listings read a bounded transcript prefix', 'the daemon also lists the startup session (no messages, shown by ID)', 'Ctrl+P shows the session ID on new, the transcript path on old', 'new always shows the position counter']),
  s('B-tree', 'Tree after two turns', [...prompt('say hi', 'first-response'), ...prompt('say bye', 'second-response'), ...command('/tree'), screen('tree'), keys('Down'), pause(), screen('selection'), ...esc()], ['tree layout', 'navigation'], ['model prose'], true),
  s('B-history', 'Prompt history picker', [...legacyClientFallback(), ...prompt('say hi', 'first-response'), ...prompt('say bye', 'second-response'), keys('C-r'), until('History'), pause(), screen('history'), keys('C-r'), pause(), screen('scope-folder'), keys('C-r'), pause(), screen('scope-all'), keys('C-r'), pause(), screen('scope-session'), keys('Down'), keys('Enter'), pause(1200), screen('selected'), pause(1200), screen('inserted')], ['picker', 'scopes', 'selection inserts text with one Enter'], ['model prose'], true),
  s('B-themes', 'Theme selector and preview', [...legacyClientFallback(), ...command('/settings', 'General'), keys('Enter'), pause(), { text: 'theme' }, pause(), screen('theme-search'), keys('Enter'), until('Theme'), pause(), screen('themes'), keys('Down'), pause(), screen('preview'), keys('Enter'), pause(), screen('applied'), ...esc()], ['theme list', 'preview', 'live colour change']),
  s('B-trust', 'Fresh workspace trust', [screen('after-trust')], ['setup-trust capture before acceptance', 'choices', 'workspace skill loads'], []),
];
