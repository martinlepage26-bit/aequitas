const locale = location.pathname.startsWith('/fr-CA') ? 'fr-CA' : 'en-CA';
const base = locale === 'fr-CA' ? 'fr-CA' : 'en-CA';
const appRoot = document.querySelector('#app');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const text = (v) => esc(v);
const proposal = (role) => locale === 'fr-CA'
  ? `${role === 'complainant' ? 'Proposition pour régler votre demande' : 'Proposition pour régler la demande présentée contre votre entreprise'} : le commerçant remplace l’article. Cette proposition n’est pas contraignante et ne constitue pas un avis juridique. Elle ne prend effet que si les deux parties y consentent. Vous pouvez consentir, refuser ou demander qu’une personne examine le dossier.`
  : `${role === 'complainant' ? 'Proposal to settle your claim' : 'Proposal to settle the claim made against your business'}: the business replaces the item. This proposal is not binding and is not legal advice. It takes effect only if both parties consent. You may consent, decline, or ask for a person to review the case.`;

fetch(`/content/${base}.json?v=9`).then(r => { if (!r.ok) throw new Error('content unavailable'); return r.json(); }).then(d => render(d)).catch(() => {
  document.title = 'Aequitas';
  appRoot.innerHTML = '<main class="shell"><h1>Aequitas</h1><p>Demo content could not be loaded. Please refresh the page.</p></main>';
});

function render(d) {
  document.documentElement.lang = locale;
  document.title = `${d.title} · Aequitas`;
  const isFr = locale === 'fr-CA';
  const login = `https://aequitas.app.pharos-ai.ca/${locale}/auth/sign-in`;
  const words = isFr ? {
    brand:'AEQUITAS', login:'Connexion',
    interactionLead:'Simulation interactive', amount:'124,50 $ CA', evidence:'Extrait de preuve fictif',
    proposal:'Proposition non contraignante', progress:'Réponses des parties', pending:'Choix attendu', consented:'Consentement donné', staff:'Examen par le personnel',
    thisAccount:'Version des faits de cette partie', actions:'Que choisit cette partie?', reset:'Recommencer', consent:'Je consens à cette proposition', decline:'Refuser cette proposition', human:'Demander l’examen par une personne',
    initial:'Choisissez une réponse pour cette vue fictive. Le choix de l’autre partie n’est pas affiché ici.', accepted:'La réponse de cette vue est enregistrée dans la simulation. Le dossier reste ouvert jusqu’au consentement des deux parties et à l’examen par l’approbateur requis.', completed:'Les deux parties fictives ont consenti. Selon les règles standard, un approbateur distinct doit encore examiner le dossier avant sa fermeture.', handoff:'L’automatisation s’arrête et transmet le dossier au personnel du programme. Aucun accord n’est enregistré.',
    footerLink:'Voir les détails du parcours'
  } : {
    brand:'AEQUITAS', login:'Sign in',
    interactionLead:'Interactive simulation', amount:'CA$124.50', evidence:'Fictional evidence excerpt',
    proposal:'Non-binding proposal', progress:'Party responses', pending:'Choice pending', consented:'Consented', staff:'Staff review',
    thisAccount:"This party’s account", actions:'What does this party choose?', reset:'Start again', consent:'I consent to this proposal', decline:'Decline this proposal', human:'Ask a person to review',
    initial:'Choose a response for this fictional view. The other party’s choice is not shown here.', accepted:'This view’s response is recorded in the simulation. The case stays open until both parties consent and the required approver reviews it.', completed:'Both fictional parties consented. Under the standard rules, a separate approver still reviews the case before closure.', handoff:'Automation stops and the case returns to program staff. No agreement is recorded.',
    footerLink:'See the workflow'
  };
  const item = (title, body, extra='') => `<article class="card ${extra}"><h3>${text(title)}</h3><p>${text(body)}</p></article>`;
  const section = (title, intro, cards, tail='', kind='') => `<section class="section ${kind}"><h2>${text(title)}</h2><p class="section-intro">${text(intro)}</p><div class="grid">${cards}</div>${tail}</section>`;
  const stepKeys = ['intake','evidence','proposal','choice'];
  const trustKeys = ['trace','separation','choice','handoff'];
  const steps = `<div class="steps">${stepKeys.map((key,i)=>`<article class="step"><span class="step-no">${String(i+1).padStart(2,'0')}</span><div><h3>${text(d.steps[key].title)}</h3><p>${text(d.steps[key].description)}</p></div></article>`).join('')}</div><aside class="handoff"><h3>${text(d.handoffTitle)}</h3><p>${text(d.handoffBody)}</p></aside>`;
  const limits = `<aside class="limits"><h3>${text(d.limits.title)}</h3><p>${text(d.limits.body)}</p></aside>`;
  const trustCards = trustKeys.map(k => item(d.trust[k].title,d.trust[k].body)).join('');
  appRoot.innerHTML = `<main class="shell">
    <nav class="topbar" aria-label="${isFr?'Navigation principale':'Main navigation'}"><a class="brand" href="/${locale}/"><span class="brand-mark" aria-hidden="true">A</span><span>${words.brand}</span></a><div class="top-actions"><div class="lang" aria-label="${isFr?'Langue':'Language'}"><a class="${isFr?'':'active'}" href="/en-CA/" lang="en-CA">EN</a><a class="${isFr?'active':''}" href="/fr-CA/" lang="fr-CA">FR</a></div><a class="login" href="${login}">${words.login} ↗</a></div></nav>
    <header class="hero"><figure class="visual"><div class="hero-image-crop"><img src="/images/aequitas-ethics-hero.png" alt="Aequitas for conflict resolution" width="1000" height="666"></div></figure><p class="hero-line">${text(d.heroLine)}</p></header>
    ${section(d.overview.title,d.overview.body,item(d.overview.kind.title,d.overview.kind.body)+item(d.overview.helps.title,d.overview.helps.body),'','overview')}
    <aside class="notice"><h2>${text(d.sampleNoticeTitle)}</h2><p>${text(d.sampleNoticeBody)}</p></aside>
    <section class="section"><div class="case-head"><div><h3>${text(d.caseTitle)}</h3><p>${text(d.caseDescription)}</p></div><div class="amount">${text(d.amountLabel)}<strong>${words.amount}</strong></div></div>
      <div class="interactive" id="try"><div class="interactive-head"><div><p class="eyebrow">${text(words.interactionLead)}</p><h2>${text(d.interaction.title)}</h2><p>${text(d.interaction.description)}</p></div><button class="reset" type="button" id="reset">${text(d.interaction.reset)}</button></div>
      <div class="role-switch" role="group" aria-label="${text(d.interaction.roleLabel)}"><button id="role-complainant" type="button" aria-pressed="true">${text(d.party.complainant)}</button><button id="role-respondent" type="button" aria-pressed="false">${text(d.party.respondent)}</button></div>
      <div class="progress"><div class="progress-title"><span>${text(d.interaction.progressTitle)}</span><span id="count">0 / 2</span></div><div class="track"><span id="fill" data-progress="0"></span></div><div class="party-progress" id="party-progress"></div></div>
      <p class="role-note">${text(d.interaction.roleNotice)}</p><div class="view-panel" id="view"></div><div class="choice-area"><h4>${text(d.interaction.choiceTitle)}</h4><p>${text(d.interaction.choiceHint)}</p><div class="choices"><button data-choice="consent">${text(d.interaction.consent)}</button><button class="secondary" data-choice="decline">${text(d.interaction.decline)}</button><button class="secondary" data-choice="person">${text(d.interaction.askPerson)}</button></div><div class="status" aria-live="polite"><strong>${text(d.interaction.statusLabel)}</strong><p id="status">${text(d.interaction.status.initial)}</p></div></div></div></section>
    <section class="section"><h2>${text(d.workflowTitle)}</h2>${steps}</section>
    ${section(d.trust.title,d.trust.intro,trustCards,`<aside class="limits"><h3>${text(d.trust.readinessTitle)}</h3><p>${text(d.trust.readinessBody)}</p></aside>`,'trust')}
    <section class="section"><h2>${text(d.inside.title)}</h2><p class="section-intro">${text(d.inside.intro)}</p><div class="process-list">${Object.values(d.inside).filter(v=>typeof v==='object'&&v.title).map(v=>`<details><summary>${text(v.title)}</summary><p>${text(v.body)}</p></details>`).join('')}</div>${limits}</section>
    <footer class="footer"><p>${text(d.pilotStatus)}</p><a href="#try">${text(words.footerLink)} ↑</a></footer>
  </main>`;
  init(d, words);
}

function init(d,w) {
  let active='complainant'; let choices={complainant:null,respondent:null};
  const parties={complainant:{label:d.party.complainant,position:d.sample.claim,evidence:d.sample.complainantEvidence},respondent:{label:d.party.respondent,position:d.sample.response,evidence:d.sample.respondentEvidence}};
  const stopped=()=>Object.values(choices).some(v=>v==='decline'||v==='person');
  const both=()=>choices.complainant==='consent'&&choices.respondent==='consent';
  function draw(){
    for(const role of ['complainant','respondent']) document.querySelector(`#role-${role}`).setAttribute('aria-pressed',String(active===role));
    const count=Object.values(choices).filter(Boolean).length; document.querySelector('#count').textContent=`${both()?2:count} / 2`;
    const fill=document.querySelector('#fill');fill.dataset.progress=String(stopped()?100:count*50);fill.classList.toggle('handoff',stopped());
    document.querySelector('#party-progress').innerHTML=['complainant','respondent'].map(role=>{const c=choices[role], status=c==='consent'?w.consented:c?w.staff:w.pending, symbol=c==='consent'?'✓':c?'↗':active===role?'●':'○';return `<div class="party"><span aria-hidden="true">${symbol}</span><span>${text(parties[role].label)}</span><small>${text(status)}</small></div>`}).join('');
    const p=parties[active];document.querySelector('#view').innerHTML=`<h3>${text(p.label)}</h3><div class="view-grid"><section class="view-field"><h4>${text(d.interaction.positionLabel)}</h4><p>${text(p.position)}</p></section><section class="view-field"><h4>${text(d.evidenceTitle)}</h4><small>${text(d.evidenceLabel)}</small><p>${text(p.evidence)}</p></section><section class="view-field wide proposal"><h4>${text(d.proposalTitle)}</h4><p>${text(d.proposalDescription)}</p><p>${text(proposal(active))}</p><small>${text(p.evidence)}</small></section></div>`;
    const status=stopped()?w.handoff:both()?w.completed:choices[active]==='consent'?w.accepted:w.initial;document.querySelector('#status').textContent=status;
    document.querySelectorAll('[data-choice]').forEach(b=>b.disabled=stopped()||both()||choices[active]!==null);
  }
  ['complainant','respondent'].forEach(role=>document.querySelector(`#role-${role}`).addEventListener('click',()=>{active=role;draw()}));
  document.querySelectorAll('[data-choice]').forEach(b=>b.addEventListener('click',()=>{if(!stopped()&&!both()&&!choices[active]){choices[active]=b.dataset.choice;draw()}}));
  document.querySelector('#reset').addEventListener('click',()=>{active='complainant';choices={complainant:null,respondent:null};draw()});draw();
}
