(function () {
  const KEY = 'kolopolyTutorial';
  const STEPS = [
    ['stand', 'I be Big Daddy. I go show you the table before you spend one naira.'],
    ['stand', 'Roll the dice and move. Doubles mean you roll again. Three doubles and Kirikiri dey wait.'],
    ['deed', 'Land on a free street and you fit buy am. The deed card keep the full name and the rent ladder.'],
    ['money', 'Land on somebody else street and you pay rent. Own the whole colour set and the rent go up. Houses go up again.'],
    ['deed', 'Build even: one duplex at a time across the set, then a mansion. You fit only build on your turn.'],
    ['stand', 'Wahala and Family Meeting cards tell you the next move. Do wetin the card talk.'],
    ['stand', 'Inflation get phases. Salary shrink, rent multiply off the dice. The first phase na 15 minutes. Later phases no pass 10.'],
    ['clap', 'Owambe pot grow from tax, fine and bail. Land on the grounds with enough inside and you fit grab am.'],
    ['money', 'Hustle na a dare on another player cash. Deals na contracts: a pass or a loan, written down.'],
    ['clap', 'Paid table: every seat pay the stake, or spend play credit. Winner collect from the final table. No bot dey play a paid seat.']
  ];
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
  }
  function write(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }
  function showStep(i) {
    const step = STEPS[i] || STEPS[0];
    const fig = document.getElementById('tutFig');
    const line = document.getElementById('tutLine');
    const prog = document.getElementById('tutProgress');
    if (fig) fig.src = '/mascot/daddy-' + (step[0] === 'stand' ? 'stand' : step[0] === 'clap' ? 'clap' : step[0] === 'money' ? 'money' : 'deed') + '.webp';
    if (line) line.textContent = step[1];
    if (prog) prog.textContent = 'Lesson ' + (i + 1) + ' of ' + STEPS.length + '. You fit replay this anytime.';
  }
  function openTutorial(start) {
    const view = document.getElementById('view-tutorial');
    document.querySelectorAll('.view').forEach((el) => { el.classList.remove('active'); if (el.id !== 'view-tutorial') el.hidden = true; });
    if (view) { view.hidden = false; view.classList.add('active'); }
    const state = read();
    state.step = start == null ? (state.step || 0) : start;
    if (state.step >= STEPS.length) state.step = 0;
    write(state);
    showStep(state.step);
  }
  function closeTutorial(done) {
    const state = read();
    if (done) { state.done = true; state.step = STEPS.length; }
    state.seen = true;
    write(state);
    const view = document.getElementById('view-tutorial');
    if (view) { view.hidden = true; view.classList.remove('active'); }
    const landing = document.getElementById('view-landing');
    if (landing) { landing.hidden = false; landing.classList.add('active'); }
    const offer = document.getElementById('tutOffer');
    if (offer) offer.hidden = true;
  }
  function paintTables(tables) {
    const box = document.getElementById('openTables');
    if (!box) return;
    const rows = (tables || []).filter((t) => t.open);
    if (!rows.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<h3>Open tables</h3>' + rows.map((t) =>
      '<div class="open-row"><div><b>' + t.code + '</b><span>' + t.mode + ' · ' + t.city + (t.paid ? ' · ₦' + t.fee : ' · free') + ' · ' + t.seats + ' seated</span></div>' +
      '<button type="button" class="btn small" data-join="' + t.code + '">Join</button></div>').join('');
    box.querySelectorAll('[data-join]').forEach((btn) => btn.addEventListener('click', () => {
      const code = document.getElementById('joinCode');
      const toggle = document.getElementById('joinToggleBtn');
      if (toggle) toggle.click();
      if (code) code.value = btn.getAttribute('data-join');
      const go = document.getElementById('joinBtn');
      if (go) go.click();
    }));
  }
  function loadTables() {
    fetch('/api/tables', { cache: 'no-store' }).then((r) => r.json()).then((data) => paintTables(data && data.tables)).catch(() => {});
  }
  document.addEventListener('DOMContentLoaded', () => {
    ['trainBtn', 'welcomeTrainBtn', 'lobbyTrainBtn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => { if (window.KPOpenTraining) window.KPOpenTraining(); });
    });
    ['profileBtn', 'welcomeProfileBtn', 'lobbyProfileBtn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => { if (window.KPOpenProfile) window.KPOpenProfile(); });
    });
    const next = document.getElementById('tutNext');
    const skip = document.getElementById('tutSkip');
    if (next) next.addEventListener('click', () => {
      const state = read();
      state.step = (state.step || 0) + 1;
      if (state.step >= STEPS.length) { closeTutorial(true); return; }
      write(state);
      showStep(state.step);
    });
    if (skip) skip.addEventListener('click', () => closeTutorial(false));
    loadTables();
    setInterval(loadTables, 15000);
  });
})();
