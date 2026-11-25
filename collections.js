/* SAT EXCELLENCE V2.34 — private annual collections */
const COLLECTION_DRAFT_KEY = 'sat_excellence_collection_drafts_v1';
let collectionDraftOwner = null;
let collectionDrafts = loadCollectionDrafts();
let collectionServerRows = [];
const collectionSyncTimers = Object.create(null);

function collectionDraftStorageKey() { return COLLECTION_DRAFT_KEY + '__' + (satCurrentUser?.id || 'offline-device'); }
function switchCollectionDraftAccount() {
  const owner = satCurrentUser?.id || 'offline-device';
  if (collectionDraftOwner === owner) return;
  for (const timer of Object.values(collectionSyncTimers)) clearTimeout(timer);
  for (const key of Object.keys(collectionSyncTimers)) delete collectionSyncTimers[key];
  collectionDraftOwner = owner; collectionDrafts = loadCollectionDrafts(); collectionServerRows = [];
}
function loadCollectionDrafts() {
  try {
    const value = JSON.parse(localStorage.getItem(collectionDraftStorageKey()) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}
function saveCollectionDrafts() {
  try { localStorage.setItem(collectionDraftStorageKey(), JSON.stringify(collectionDrafts)); return true; }
  catch (error) { alert('Private collection drafts could not be saved. Create a backup and free device storage.'); return false; }
}
function collectionQuestionKey(question) {
  return duplicateFingerprint(question, question?.year || '') || String(question?.id || '');
}
function setCollectionMessage(message, type = 'info') {
  const element = document.getElementById('collectionMessage');
  if (!element) return;
  element.className = type === 'error' ? 'auth-message error' : 'notice';
  element.textContent = message;
}
function saveCollectionDraftQuestion(question) {
  const year = String(question.year || '').trim();
  if (!year) { alert('An examination year is required.'); return false; }
  const record = collectionDrafts[year] || {questions: [], exam_completed: false};
  const key = collectionQuestionKey(question);
  if (record.questions.some(item => String(item.id) === String(question.id) || collectionQuestionKey(item) === key)) {
    alert('This question already exists in this annual collection.');
    return false;
  }
  record.questions.push({...question, status: 'Draft'});
  collectionDrafts[year] = record;
  if (!saveCollectionDrafts()) return false;
  if (navigator.onLine && satSupabase && satCurrentUser) scheduleCollectionSync(year);
  return true;
}
function scheduleCollectionSync(year) {
  const ownerId = satCurrentUser?.id;
  if (!ownerId) return;
  if (collectionSyncTimers[year]) clearTimeout(collectionSyncTimers[year]);
  collectionSyncTimers[year] = setTimeout(() => syncCollectionDraftYear(year, ownerId), 400);
}
async function syncCollectionDraftYear(year, expectedOwnerId = satCurrentUser?.id) {
  if (!satSupabase || !satCurrentUser || satCurrentUser.id !== expectedOwnerId || !satCan('add_questions') || !navigator.onLine) return false;
  const local = collectionDrafts[year] || {questions: [], exam_completed: false, exam_completed_dirty: false};
  try {
    const {data, error} = await satSupabase.from('question_collections')
      .select('id,exam_year,questions,exam_completed,status,created_by,updated_at,ready_at,reviewed_at,published_at')
      .eq('exam_year', year).maybeSingle();
    if (error) throw error;
    if (satCurrentUser?.id !== expectedOwnerId) return false;
    const row = data;
    if (row?.status === 'published') throw new Error('This year’s collection is already published and locked.');
    const merged = Array.isArray(row?.questions) ? row.questions.slice() : [];
    const examCompleted = local.exam_completed_dirty ? !!local.exam_completed : !!(local.exam_completed || row?.exam_completed);
    const ids = new Set(merged.map(item => String(item.id)));
    const keys = new Set(merged.map(collectionQuestionKey));
    for (const question of (local.questions || [])) {
      const key = collectionQuestionKey(question);
      if (!ids.has(String(question.id)) && !keys.has(key)) {
        merged.push(question);
        ids.add(String(question.id));
        keys.add(key);
      }
    }
    if (satCurrentUser?.id !== expectedOwnerId) return false;
    if (row) {
      const questionsChanged = JSON.stringify(merged) !== JSON.stringify(row.questions || []);
      const completionChanged = examCompleted !== !!row.exam_completed;
      if (questionsChanged || completionChanged) {
        const result = await satSupabase.from('question_collections')
          .update({questions: merged, exam_completed: examCompleted})
          .eq('id', row.id);
        if (result.error) throw result.error;
      }
    } else {
      const result = await satSupabase.from('question_collections').insert({
        exam_year: year, questions: merged, exam_completed: examCompleted, created_by: expectedOwnerId
      });
      if (result.error) throw result.error;
    }
    if (satCurrentUser?.id !== expectedOwnerId) return false;
    collectionDrafts[year] = {questions: merged, exam_completed: examCompleted, exam_completed_dirty: false};
    saveCollectionDrafts();
    await loadAnnualCollections(false);
    setCollectionMessage('Collection saved to the shared database. It remains unpublished until reviewed and manually published.', 'success');
    return true;
  } catch (error) {
    console.error('Collection sync failed:', error);
    setCollectionMessage('Your draft remains on this device. Shared sync failed: ' + (error.message || 'Unknown error'), 'error');
    return false;
  }
}
async function loadAnnualCollections(showMessage = true) {
  const select = document.getElementById('collectionYearSelect');
  if (!select) return;
  const previous = select.value;
  if (satSupabase && satCurrentUser && satCan('add_questions') && navigator.onLine) {
    try {
      const {data, error} = await satSupabase.from('question_collections')
        .select('id,exam_year,questions,exam_completed,status,created_by,updated_at,ready_at,reviewed_at,published_at')
        .order('exam_year', {ascending: false});
      if (error) throw error;
      collectionServerRows = data || [];
    } catch (error) {
      console.error('Could not load annual collections:', error);
      if (showMessage) setCollectionMessage('Could not load shared collections: ' + (error.message || 'Unknown error'), 'error');
    }
  }
  const years = [...new Set([...Object.keys(collectionDrafts), ...collectionServerRows.map(row => row.exam_year)])]
    .sort((a, b) => String(b).localeCompare(String(a), undefined, {numeric: true}));
  select.innerHTML = '<option value="">Choose a year</option>' + years.map(year =>
    '<option value="' + esc(year) + '">' + esc(year) + '</option>').join('');
  if (previous && years.includes(previous)) select.value = previous;
  else if (years.length) select.value = years[0];
  renderSelectedCollection();
}
function renderSelectedCollection() {
  const year = document.getElementById('collectionYearSelect')?.value || '';
  const server = collectionServerRows.find(row => row.exam_year === year) || null;
  const local = collectionDrafts[year] || {questions: [], exam_completed: false, exam_completed_dirty: false};
  const items = Array.isArray(server?.questions) ? server.questions.slice() : [];
  const ids = new Set(items.map(item => String(item.id)));
  const keys = new Set(items.map(collectionQuestionKey));
  for (const question of (local.questions || [])) {
    const key = collectionQuestionKey(question);
    if (!ids.has(String(question.id)) && !keys.has(key)) { items.push(question); ids.add(String(question.id)); keys.add(key); }
  }
  const status = server?.status || (items.length >= 60 || local.exam_completed ? 'ready' : 'collecting');
  const count = document.getElementById('collectionQuestionCount');
  const state = document.getElementById('collectionStatus');
  const label = document.getElementById('collectionYearLabel');
  const completed = document.getElementById('collectionExamCompleted');
  const list = document.getElementById('collectionQuestionList');
  if (count) count.textContent = String(items.length);
  if (state) state.textContent = status;
  if (label) label.textContent = year || '—';
  if (completed) completed.checked = local.exam_completed_dirty ? !!local.exam_completed : !!(server?.exam_completed || local.exam_completed);
  const review = document.getElementById('reviewCollectionBtn');
  const publish = document.getElementById('publishCollectionBtn');
  const sync = document.getElementById('syncCollectionBtn');
  if (review) review.disabled = status !== 'ready' || !server || !satCan('add_questions');
  if (publish) publish.disabled = status !== 'reviewed' || !server || !satCan('add_questions');
  if (sync) sync.disabled = !year || status === 'published' || !satCan('add_questions');
  if (completed) completed.disabled = !year || status === 'published' || !satCan('add_questions');
  if (list) list.innerHTML = items.length ? items.map((question, index) =>
    '<article class="question"><div class="qhead"><span class="qnumber">' + (index + 1) +
    '</span><div class="qbody"><div class="qmeta">' + esc(question.part || '') + ' • ' + esc(question.topic || '') +
    ' • ' + esc(question.year || year) + '</div><strong>' + esc(question.question || '') +
    '</strong></div></div><div class="muted">' + (question.options || []).map((option, i) =>
    String.fromCharCode(65 + i) + '. ' + esc(option)).join(' · ') + '</div></article>').join('') : 'No questions have been added to this year yet.';
}
async function syncSelectedCollection() {
  const year = document.getElementById('collectionYearSelect')?.value;
  if (!year) { setCollectionMessage('Choose an examination year first.', 'error'); return; }
  await syncCollectionDraftYear(year);
}
async function setCollectionExamCompleted(checked) {
  const year = document.getElementById('collectionYearSelect')?.value;
  if (!year) return;
  const local = collectionDrafts[year] || {questions: [], exam_completed: false};
  local.exam_completed = !!checked;
  local.exam_completed_dirty = true;
  collectionDrafts[year] = local;
  saveCollectionDrafts();
  if (satSupabase && satCurrentUser && navigator.onLine) await syncCollectionDraftYear(year);
  else { setCollectionMessage('Completion status saved locally. It will sync when you are online.'); renderSelectedCollection(); }
}
async function reviewSelectedCollection() {
  const year = document.getElementById('collectionYearSelect')?.value;
  const row = collectionServerRows.find(item => item.exam_year === year);
  if (!row) return;
  if (!confirm('Confirm that you have reviewed the entire ' + year + ' collection, including every question, answer, and explanation?')) return;
  try {
    const {error} = await satSupabase.rpc('review_question_collection', {target_collection_id: row.id});
    if (error) throw error;
    await loadAnnualCollections(false);
    setCollectionMessage('Collection review recorded. Publishing is still a separate manual action.', 'success');
  } catch (error) { setCollectionMessage('Could not record review: ' + (error.message || 'Unknown error'), 'error'); }
}
async function publishSelectedCollection() {
  const year = document.getElementById('collectionYearSelect')?.value;
  const row = collectionServerRows.find(item => item.exam_year === year);
  if (!row) return;
  if (!confirm('Publish all ' + (row.questions || []).length + ' questions from ' + year + ' to the official Question Bank? This is a one-time action and the collection will be locked.')) return;
  try {
    const {data, error} = await satSupabase.rpc('publish_question_collection', {target_collection_id: row.id});
    if (error) throw error;
    setCollectionMessage(String(data) + ' question(s) published. Refreshing the official question bank…', 'success');
    if (typeof window.loadSharedQuestions === 'function') await window.loadSharedQuestions();
    await loadAnnualCollections(false);
  } catch (error) { setCollectionMessage('Could not publish this collection: ' + (error.message || 'Unknown error'), 'error'); }
}

document.getElementById('collectionYearSelect')?.addEventListener('change', renderSelectedCollection);
document.getElementById('collectionExamCompleted')?.addEventListener('change', event => setCollectionExamCompleted(event.target.checked));
window.addEventListener('online', () => { for (const year of Object.keys(collectionDrafts)) scheduleCollectionSync(year); });

// Expose the handlers used by the existing form and inline controls.
window.switchCollectionDraftAccount = switchCollectionDraftAccount;
window.saveCollectionDraftQuestion = saveCollectionDraftQuestion;
window.loadAnnualCollections = loadAnnualCollections;
window.syncSelectedCollection = syncSelectedCollection;
window.reviewSelectedCollection = reviewSelectedCollection;
window.publishSelectedCollection = publishSelectedCollection;
window.setCollectionMessage = setCollectionMessage;
