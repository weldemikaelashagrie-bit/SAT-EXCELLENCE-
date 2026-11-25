/* SAT EXCELLENCE V2.34 — shared Supabase data and offline queues */
const QUESTION_QUEUE_KEY = 'sat_excellence_question_sync_queue_v1';
const SUBMISSION_QUEUE_KEY = 'sat_excellence_submission_sync_queue_v1';
const WORKSPACE_SYNC_DELAY = 500;
const WORKSPACE_DIRTY_KEY = 'sat_excellence_workspace_dirty_v1';
const WORKSPACE_UPDATED_KEY = 'sat_excellence_workspace_updated_v1';
const WORKSPACE_SYNCED_KEY = 'sat_excellence_workspace_synced_v1';
const WORKSPACE_CONFLICT_KEY = 'sat_excellence_workspace_conflict_backup_v1';
const WORKSPACE_OWNER_KEY = 'sat_excellence_workspace_owner_v1';
let workspaceSyncTimer = null;
let lastWorkspaceSyncAt = 0;

function makeSubmissionUuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}
function readQueue(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; }
  catch (_) { return []; }
}
function writeQueue(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (error) { console.error('Could not save offline sync queue:', error); return false; }
}
function questionPayload(question, includeOwner = false) {
  const payload = {
    id: String(question.id), part: question.part || null, topic: String(question.topic || ''),
    year: String(question.year || ''), difficulty: question.difficulty || null,
    question: String(question.question || ''), options: Array.isArray(question.options) ? question.options : [],
    answer: Number.isInteger(Number(question.answer)) ? Number(question.answer) : 0,
    explanation: question.explanation || '', explanation_details: question.explanationDetails || {}, status: 'Verified'
  };
  if (includeOwner) payload.created_by = satCurrentUser.id;
  return payload;
}
function queueOfficialQuestionSync(question, operation = 'insert') {
  if (!satCurrentUser || !question?.id) return false;
  const queue = readQueue(QUESTION_QUEUE_KEY);
  queue.push({operation, question: JSON.parse(JSON.stringify(question)), userId: satCurrentUser.id, queuedAt: Date.now()});
  writeQueue(QUESTION_QUEUE_KEY, queue);
  updateSharedSyncStatus();
  if (navigator.onLine) flushQuestionSyncQueue();
  return true;
}
function queueOfficialQuestionDelete(id) {
  if (!satCurrentUser || !id) return false;
  const queue = readQueue(QUESTION_QUEUE_KEY);
  queue.push({operation: 'delete', question: {id}, userId: satCurrentUser.id, queuedAt: Date.now()});
  writeQueue(QUESTION_QUEUE_KEY, queue);
  if (navigator.onLine) flushQuestionSyncQueue();
  updateSharedSyncStatus();
  return true;
}
async function flushQuestionSyncQueue() {
  if (!satSupabase || !satCurrentUser || !navigator.onLine) return;
  let queue = readQueue(QUESTION_QUEUE_KEY);
  if (!queue.length) { updateSharedSyncStatus(); return; }
  const remaining = [];
  for (const job of queue) {
    if (job.userId !== satCurrentUser.id) { remaining.push(job); continue; }
    try {
      if (job.operation === 'insert') {
        if (!satCan('add_questions')) { remaining.push(job); continue; }
        const {error} = await satSupabase.from('questions').insert(questionPayload(job.question, true));
        if (error && error.code !== '23505') throw error;
      } else if (job.operation === 'update') {
        if (!satCan('edit_questions')) { remaining.push(job); continue; }
        const payload = questionPayload(job.question, false); delete payload.id; delete payload.status;
        const {error} = await satSupabase.from('questions').update(payload).eq('id', String(job.question.id));
        if (error) throw error;
      } else if (job.operation === 'delete') {
        if (!satCan('delete_questions')) { remaining.push(job); continue; }
        const {data, error} = await satSupabase.from('questions').delete().eq('id', String(job.question.id)).select('id');
        if (error) throw error;
        // An empty result is safe only when the row is already absent (idempotent retry).
        if (!data || !data.length) {
          const check = await satSupabase.from('questions').select('id').eq('id', String(job.question.id)).maybeSingle();
          if (check.error) throw check.error;
          if (check.data) throw new Error('The question still exists remotely; deletion was not confirmed.');
        }
      }
    } catch (error) {
      console.error('Question sync is still pending:', error);
      remaining.push(job);
    }
  }
  writeQueue(QUESTION_QUEUE_KEY, remaining);
  updateSharedSyncStatus();
}
async function loadSharedQuestions() {
  if (!satSupabase || !satCurrentUser || !navigator.onLine) return false;
  try {
    const {data, error} = await satSupabase.from('questions').select('*').eq('status', 'Verified').order('display_order', {ascending: true});
    if (error) throw error;
    const local = Array.isArray(questions) ? questions.slice() : [];
    const localById = new Map(local.map(item => [String(item.id), item]));
    const remoteById = new Map((data || []).map(row => [String(row.id), row]));
    const pending = readQueue(QUESTION_QUEUE_KEY).filter(job => job.userId === satCurrentUser.id);
    const pendingById = new Map(pending.map(job => [String(job.question?.id), job]));
    // The server is authoritative: a locally cached row absent remotely is removed,
    // unless this account has a still-pending insert/update for that exact question.
    const merged = (data || []).filter(row => pendingById.get(String(row.id))?.operation !== 'delete').map(row => {
      const item = localById.get(String(row.id)) || {};
      return {...item, id: row.id, part: row.part || '', topic: row.topic || '', year: row.year || '', difficulty: row.difficulty || '', question: row.question || '', options: row.options || [], answer: Number.isInteger(row.answer) ? row.answer : -1, explanation: row.explanation || '', explanationDetails: row.explanation_details || item.explanationDetails || {}, status: row.status || 'Verified', display_order: row.display_order};
    });
    const mergedIds = new Set(merged.map(item => String(item.id)));
    for (const [id, job] of pendingById) {
      if (!id || mergedIds.has(id) || job.operation === 'delete') continue;
      if (job.operation === 'insert' || job.operation === 'update') {
        merged.push({...job.question, status: job.question.status || 'Verified'});
        mergedIds.add(id);
      }
    }
    questions = merged;
    localStorage.setItem(KEY, JSON.stringify(questions));
    renderAll();
    await flushQuestionSyncQueue();
    updateSharedSyncStatus();
    return true;
  } catch (error) {
    console.error('Shared question bank could not load:', error);
    updateSharedSyncStatus('Shared question bank could not refresh. Your saved local copy is still available.');
    return false;
  }
}
async function syncLocalQuestionBank() {
  if (!satSupabase || !satCurrentUser || !satCan('add_questions') || !navigator.onLine) {
    alert('Connect to the internet and sign in with question-add permission before syncing the local question bank.');
    return;
  }
  let remoteIds = new Set();
  try {
    const {data, error} = await satSupabase.from('questions').select('id');
    if (error) throw error;
    remoteIds = new Set((data || []).map(row => String(row.id)));
    const pendingDeletes = new Set(readQueue(QUESTION_QUEUE_KEY).filter(job => job.userId === satCurrentUser.id && job.operation === 'delete').map(job => String(job.question?.id)));
    const candidates = questions.filter(question => !remoteIds.has(String(question.id)) && !pendingDeletes.has(String(question.id)));
    if (!candidates.length) { alert('All locally saved questions are already in the shared bank.'); return; }
    if (!confirm('Upload ' + candidates.length + ' local question(s) to the shared official bank? Existing shared questions will not be replaced.')) return;
    let added = 0, skipped = 0;
    for (const question of candidates) {
      try {
        const {error: insertError} = await satSupabase.from('questions').insert(questionPayload(question, true));
        if (insertError) { if (insertError.code === '23505') skipped++; else throw insertError; }
        else added++;
      } catch (error) { console.error('Question upload failed:', error); skipped++; }
    }
    await loadSharedQuestions();
    alert(added + ' question(s) uploaded. ' + skipped + ' were skipped or need review.');
  } catch (error) { alert('Could not upload the local question bank: ' + (error.message || 'Unknown error')); }
}
function queueSubmissionSync(item) {
  if (!satCurrentUser || !item) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(item.submissionId || ''))) item.submissionId = makeSubmissionUuid();
  const queue = readQueue(SUBMISSION_QUEUE_KEY);
  const question = item.questionData || {};
  queue.push({userId: satCurrentUser.id, item: JSON.parse(JSON.stringify(item)), queuedAt: Date.now()});
  writeQueue(SUBMISSION_QUEUE_KEY, queue);
  if (navigator.onLine) flushSubmissionQueue();
  updateSharedSyncStatus();
  return true;
}
async function flushSubmissionQueue() {
  if (!satSupabase || !satCurrentUser || !navigator.onLine) return;
  const queue = readQueue(SUBMISSION_QUEUE_KEY), remaining = [];
  for (const job of queue) {
    if (job.userId !== satCurrentUser.id) { remaining.push(job); continue; }
    const q = job.item.questionData || {};
    try {
      const {error} = await satSupabase.from('submissions').insert({
        id: job.item.submissionId, submitted_by: job.userId, part: q.part, topic: q.topic,
        year: q.year, difficulty: q.difficulty || null, question: q.question, options: q.options,
        answer: Number(q.answer) >= 0 ? Number(q.answer) : null, explanation: q.explanation || '',
        explanation_details: q.explanationDetails || {}, status: 'pending'
      });
      if (error && error.code !== '23505') throw error;
      const local = submissions.find(item => String(item.submissionId) === String(job.item.submissionId));
      if (local) local.dbSynced = true;
    } catch (error) { console.error('Submission sync is still pending:', error); remaining.push(job); }
  }
  writeQueue(SUBMISSION_QUEUE_KEY, remaining);
  saveSubmissions();
  updateSharedSyncStatus();
}
async function loadSharedSubmissions() {
  if (!satSupabase || !satCurrentUser || !navigator.onLine) return false;
  try {
    let result = await satSupabase.from('submissions').select('*').order('created_at', {ascending: false});
    if (result.error && /review_note|column/i.test(result.error.message || '')) {
      result = await satSupabase.from('submissions').select('id,submitted_by,part,topic,year,difficulty,question,options,answer,explanation,explanation_details,status,reviewed_by,created_at').order('created_at', {ascending: false});
    }
    if (result.error) throw result.error;
    const remote = (result.data || []).map(row => ({
      submissionId: String(row.id), submittedBy: row.submitted_by === satCurrentUser.id ? (satCurrentProfile?.Username || satCurrentProfile?.full_name || 'You') : ('Student ' + String(row.submitted_by || '').slice(0, 8)),
      submittedAt: row.created_at || new Date().toISOString(), reviewStatus: String(row.status || 'pending').replace(/^./, c => c.toUpperCase()),
      reviewNote: row.review_note || '', dbSynced: true,
      questionData: {id: String(row.id), part: row.part || '', topic: row.topic || '', year: row.year || '', difficulty: row.difficulty || '', question: row.question || '', options: row.options || [], answer: Number.isInteger(row.answer) ? row.answer : -1, explanation: row.explanation || '', explanationDetails: row.explanation_details || {}, status: row.status || 'pending'}
    }));
    const localUnsent = submissions.filter(item => !item.dbSynced && ['Pending','pending'].includes(item.reviewStatus) && !remote.some(row => String(row.submissionId) === String(item.submissionId)));
    submissions = [...remote, ...submissions.filter(item => !remote.some(row => String(row.submissionId) === String(item.submissionId)) && !localUnsent.includes(item)), ...localUnsent];
    localStorage.setItem(SUB_KEY, JSON.stringify(submissions));
    const alreadyQueued = new Set(readQueue(SUBMISSION_QUEUE_KEY).map(job => String(job.item?.submissionId)));
    for (const item of localUnsent) if (!alreadyQueued.has(String(item.submissionId))) queueSubmissionSync(item);
    renderSubmissions();
    updateSharedSyncStatus();
    return true;
  } catch (error) {
    console.error('Shared submissions could not load:', error);
    updateSharedSyncStatus('Submission sync needs attention: ' + (error.message || 'Unknown error'));
    return false;
  }
}
async function resubmitSubmissionShared(id, questionData) {
  if (!satSupabase || !satCurrentUser || !navigator.onLine) {
    alert('Resubmitting a rejected question requires an internet connection. Your edits remain in the form.');
    return false;
  }
  try {
    const {error} = await satSupabase.rpc('resubmit_question_submission', {
      target_submission_id: id,
      question_data: {
        part: questionData.part, topic: questionData.topic, year: questionData.year,
        difficulty: questionData.difficulty || null, question: questionData.question,
        options: questionData.options, answer: Number(questionData.answer),
        explanation: questionData.explanation || '', explanationDetails: questionData.explanationDetails || {}
      }
    });
    if (error) throw error;
    await loadSharedSubmissions();
    return true;
  } catch (error) {
    alert('Could not resubmit this question: ' + (error.message || 'Unknown error'));
    return false;
  }
}

async function rejectSubmissionShared(id) {
  const item = submissions.find(row => String(row.submissionId) === String(id));
  if (!item || !satCan('review_submissions')) return;
  const reason = prompt('Enter a clear reason so the student can correct the submission:');
  if (reason === null) return;
  if (!reason.trim()) { alert('A rejection reason is required.'); return; }
  if (!satSupabase || !navigator.onLine) { alert('Rejection requires an internet connection.'); return; }
  try {
    const {error} = await satSupabase.rpc('reject_submission_with_note', {target_submission_id: id, rejection_note: reason.trim()});
    if (error) throw error;
    await loadSharedSubmissions();
  } catch (error) { alert('Could not reject this submission: ' + (error.message || 'Unknown error')); }
}
function scheduleWorkspaceSync() {
  if (!satCurrentUser) return;
  try { localStorage.setItem(WORKSPACE_DIRTY_KEY, '1'); localStorage.setItem(WORKSPACE_UPDATED_KEY, String(Date.now())); } catch (_) {}
  if (workspaceSyncTimer) return;
  const elapsed = Date.now() - lastWorkspaceSyncAt;
  const delay = Math.max(WORKSPACE_SYNC_DELAY, 10000 - elapsed);
  workspaceSyncTimer = setTimeout(async () => {
    workspaceSyncTimer = null;
    lastWorkspaceSyncAt = Date.now();
    await syncStudentWorkspace();
  }, delay);
}
async function syncStudentWorkspace() {
  if (!satSupabase || !satCurrentUser || !navigator.onLine) return false;
  try {
    const activeExam = (() => { try { return JSON.parse(localStorage.getItem(ACTIVE_EXAM_KEY) || 'null'); } catch (_) { return null; } })();
    const payload = {user_id: satCurrentUser.id, score_history: scoreHistory || [], mistake_ids: mistakeIds || [], mistake_stats: mistakeStats || {}, bookmark_ids: bookmarkIds || [], active_exam: activeExam, updated_at: new Date().toISOString()};
    const {error} = await satSupabase.from('student_workspace').upsert(payload, {onConflict: 'user_id'});
    if (error) throw error;
    localStorage.removeItem(WORKSPACE_DIRTY_KEY);
    localStorage.setItem(WORKSPACE_UPDATED_KEY, String(Date.now()));
    localStorage.setItem(WORKSPACE_SYNCED_KEY, String(Date.now()));
    updateSharedSyncStatus();
    return true;
  } catch (error) { console.error('Student progress sync failed:', error); updateSharedSyncStatus('Progress saved on this device; shared sync will retry when possible.'); return false; }
}
async function loadStudentWorkspace() {
  if (!satSupabase || !satCurrentUser || !navigator.onLine) return false;
  try {
    const owner = localStorage.getItem(WORKSPACE_OWNER_KEY);
    if (owner !== satCurrentUser.id) {
      // Preserve an unowned/previous account snapshot locally for manual backup,
      // but never merge it into another account's cloud workspace.
      const previous = {owner: owner || 'unassigned-device-data', scores: scoreHistory || [], mistakes: mistakeIds || [], mistakeStats: mistakeStats || {}, bookmarks: bookmarkIds || [], activeExam: (() => { try { return JSON.parse(localStorage.getItem(ACTIVE_EXAM_KEY) || 'null'); } catch (_) { return null; } })()};
      if (previous.scores.length || previous.mistakes.length || Object.keys(previous.mistakeStats).length || previous.bookmarks.length || previous.activeExam) {
        try { localStorage.setItem(WORKSPACE_CONFLICT_KEY + '__' + (owner || 'unassigned'), JSON.stringify(previous)); localStorage.setItem(WORKSPACE_CONFLICT_KEY, '1'); } catch (_) {}
      }
      scoreHistory = []; mistakeIds = []; mistakeStats = {}; bookmarkIds = []; submissions = [];
      localStorage.setItem(SUB_KEY, '[]');
      localStorage.removeItem(ACTIVE_EXAM_KEY);
      localStorage.setItem(SCORE_KEY, '[]'); localStorage.setItem(MISTAKE_KEY, '[]');
      localStorage.setItem(MISTAKE_STATS_KEY, '{}'); localStorage.setItem(BOOKMARK_KEY, '[]');
      localStorage.removeItem(WORKSPACE_DIRTY_KEY); localStorage.removeItem(WORKSPACE_SYNCED_KEY);
      localStorage.setItem(WORKSPACE_OWNER_KEY, satCurrentUser.id);
    }
    const {data, error} = await satSupabase.from('student_workspace').select('*').eq('user_id', satCurrentUser.id).maybeSingle();
    if (error) throw error;
    const localExam = (() => { try { return JSON.parse(localStorage.getItem(ACTIVE_EXAM_KEY) || 'null'); } catch (_) { return null; } })();
    if (!data) {
      // Start a new account with an empty workspace; never upload old device-local data.
      scoreHistory = []; mistakeIds = []; mistakeStats = {}; bookmarkIds = [];
      localStorage.setItem(SCORE_KEY, '[]'); localStorage.setItem(MISTAKE_KEY, '[]');
      localStorage.setItem(MISTAKE_STATS_KEY, '{}'); localStorage.setItem(BOOKMARK_KEY, '[]');
      localStorage.removeItem(ACTIVE_EXAM_KEY);
      await syncStudentWorkspace(); return true;
    }

    const syncedBefore = Number(localStorage.getItem(WORKSPACE_SYNCED_KEY) || 0);
    const localDirty = localStorage.getItem(WORKSPACE_DIRTY_KEY) === '1';
    const localUpdated = Number(localStorage.getItem(WORKSPACE_UPDATED_KEY) || 0);
    const remoteUpdated = new Date(data.updated_at || 0).getTime() || 0;

    // First V2.34 sync: merge the old device-only data with any existing server data.
    if (!syncedBefore) {
      const scores = [...(scoreHistory || []), ...(data.score_history || [])];
      scoreHistory = [...new Map(scores.map(item => [String(item.id || JSON.stringify(item)), item])).values()].sort((a,b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0,100);
      mistakeIds = [...new Map([...(mistakeIds || []), ...(data.mistake_ids || [])].map(id => [String(id), id])).values()];
      bookmarkIds = [...new Map([...(bookmarkIds || []), ...(data.bookmark_ids || [])].map(id => [String(id), id])).values()];
      const combinedStats = {...(data.mistake_stats || {})};
      for (const [id, stat] of Object.entries(mistakeStats || {})) {
        const old = combinedStats[id] || {count: 0, lastMistake: null};
        const oldDate = old.lastMistake ? new Date(old.lastMistake).getTime() : 0;
        const newDate = stat.lastMistake ? new Date(stat.lastMistake).getTime() : 0;
        combinedStats[id] = {count: Math.max(Number(old.count)||0, Number(stat.count)||0), lastMistake: newDate > oldDate ? stat.lastMistake : old.lastMistake || stat.lastMistake || null};
      }
      mistakeStats = combinedStats;
      const remoteExam = data.active_exam || null;
      const selectedExam = remoteExam && (!localExam || Number(remoteExam.savedAt || 0) > Number(localExam.savedAt || 0)) ? remoteExam : localExam;
      if (selectedExam) localStorage.setItem(ACTIVE_EXAM_KEY, JSON.stringify(selectedExam));
      localStorage.setItem(SCORE_KEY, JSON.stringify(scoreHistory));
      localStorage.setItem(MISTAKE_KEY, JSON.stringify(mistakeIds));
      localStorage.setItem(MISTAKE_STATS_KEY, JSON.stringify(mistakeStats));
      localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bookmarkIds));
      scheduleWorkspaceSync();
      return true;
    }

    // Later syncs use a last-updated snapshot so removals (not just additions) sync correctly.
    if (localDirty && localUpdated > remoteUpdated) {
      await syncStudentWorkspace();
      return true;
    }
    if (localDirty && remoteUpdated > localUpdated) {
      const conflict = {savedAt: localUpdated, scores: scoreHistory, mistakes: mistakeIds, mistakeStats, bookmarks: bookmarkIds, activeExam: localExam};
      localStorage.setItem(WORKSPACE_CONFLICT_KEY, JSON.stringify(conflict));
    }
    scoreHistory = Array.isArray(data.score_history) ? data.score_history : [];
    mistakeIds = Array.isArray(data.mistake_ids) ? data.mistake_ids : [];
    mistakeStats = data.mistake_stats && typeof data.mistake_stats === 'object' ? data.mistake_stats : {};
    bookmarkIds = Array.isArray(data.bookmark_ids) ? data.bookmark_ids : [];
    if (data.active_exam) localStorage.setItem(ACTIVE_EXAM_KEY, JSON.stringify(data.active_exam));
    else localStorage.removeItem(ACTIVE_EXAM_KEY);
    localStorage.setItem(SCORE_KEY, JSON.stringify(scoreHistory));
    localStorage.setItem(MISTAKE_KEY, JSON.stringify(mistakeIds));
    localStorage.setItem(MISTAKE_STATS_KEY, JSON.stringify(mistakeStats));
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bookmarkIds));
    localStorage.removeItem(WORKSPACE_DIRTY_KEY);
    localStorage.setItem(WORKSPACE_UPDATED_KEY, String(remoteUpdated));
    localStorage.setItem(WORKSPACE_SYNCED_KEY, String(Date.now()));
    updateSharedSyncStatus();
    return true;
  } catch (error) { console.error('Student workspace could not load:', error); updateSharedSyncStatus('Progress remains available locally; shared progress could not load.'); return false; }
}

function updateSharedSyncStatus(customMessage = null) {
  const element = document.getElementById('syncStatus');
  if (!element) return;
  if (customMessage) { element.textContent = customMessage; return; }
  if (!satCurrentUser || !satSupabase) { element.textContent = 'Sign in and connect to the internet to synchronise shared data.'; return; }
  const questionsPending = readQueue(QUESTION_QUEUE_KEY).length;
  const submissionsPending = readQueue(SUBMISSION_QUEUE_KEY).length;
  if (!navigator.onLine) { element.textContent = 'Offline. Changes are saved locally and queued for synchronisation.'; return; }
  if (localStorage.getItem(WORKSPACE_CONFLICT_KEY)) { element.textContent = 'A conflicting offline progress snapshot was preserved locally. Create a backup before clearing browser data.'; return; }
  const pending = questionsPending + submissionsPending;
  element.textContent = pending ? pending + ' change(s) waiting to synchronise. Your local work is saved.' : 'Connected. Shared questions, submissions, and student progress are synchronised when changes are made.';
}

window.addEventListener('online', async () => {
  await flushQuestionSyncQueue();
  await flushSubmissionQueue();
  await loadStudentWorkspace();
  updateSharedSyncStatus();
});
window.addEventListener('offline', updateSharedSyncStatus);
window.queueOfficialQuestionSync = queueOfficialQuestionSync;
window.queueOfficialQuestionDelete = queueOfficialQuestionDelete;
window.loadSharedQuestions = loadSharedQuestions;
window.syncLocalQuestionBank = syncLocalQuestionBank;
window.queueSubmissionSync = queueSubmissionSync;
window.loadSharedSubmissions = loadSharedSubmissions;
window.rejectSubmissionShared = rejectSubmissionShared;
window.resubmitSubmissionShared = resubmitSubmissionShared;
window.makeSubmissionUuid = makeSubmissionUuid;
window.scheduleWorkspaceSync = scheduleWorkspaceSync;
window.syncStudentWorkspace = syncStudentWorkspace;
window.loadStudentWorkspace = loadStudentWorkspace;
window.updateSharedSyncStatus = updateSharedSyncStatus;
