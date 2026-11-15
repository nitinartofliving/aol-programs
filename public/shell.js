// Tab shell: each tool loads in its own frame the first time its tab opens,
// and stays loaded (with whatever you typed) while you switch tabs.
const tabs = ['home', 'outreach', 'flyer', 'survey', 'ask', 'staff'];

function show(name) {
  const openPeople = name === 'people';
  const staffFrame = openPeople ? document.querySelector('#panel-staff iframe') : null;
  if (openPeople) {
    name = 'staff';
    history.replaceState(null, '', '#staff');
  }
  if (!tabs.includes(name)) name = 'home';
  for (const t of tabs) {
    const panel = document.getElementById('panel-' + t);
    panel.hidden = t !== name;
    if (t === name && panel.dataset.src && !panel.querySelector('iframe')) {
      const f = document.createElement('iframe');
      f.src = openPeople ? panel.dataset.src + '#people' : panel.dataset.src;
      f.title = panel.getAttribute('aria-label');
      panel.append(f);
    }
  }
  if (staffFrame) staffFrame.contentWindow.location.hash = '#people';
  document.querySelectorAll('.tabs [data-tab]').forEach(a => {
    const on = a.dataset.tab === name;
    a.setAttribute('aria-selected', String(on));
    a.classList.toggle('active', on);
    if (on) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  const label = document.getElementById('panel-' + name).getAttribute('aria-label');
  document.title = name === 'home' ? 'AOL Programs' : label + ' · AOL Programs';
}

document.getElementById('surveyLink').textContent = location.origin + '/survey/';
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1));
