import * as ui from './ui.js';

// State
let questions = [];
let currentQuestionIndex = 0;
let userAnswers = {};
let flaggedQuestions = new Set();
let timerInterval;
let saveStateTimer;
const EXAM_DURATION = 180 * 60; // 3 hours in seconds
const TOTAL_QUESTIONS = 100;
const STORAGE_KEY = 'theory_exam_start_time';
const END_TIME_KEY = 'theory_exam_end_time';
const STATE_KEY = 'theory_exam_state';
const QUESTIONS_KEY = 'theory_exam_questions';

// New, smaller cookie for the question *plan*, not the whole questions array
const PLAN_KEY = 'theory_exam_plan';

function seededRandom(seed) {
    // Mulberry32 PRNG
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

function shuffleArray(array, seed = null) {
    // Fisher-Yates shuffle, optionally seeded
    let random = Math.random;
    if (seed !== null) {
        random = () => seededRandom(seed++);
    }
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// Helper to shuffle an array in-place with a seed
function shuffleArrayInPlace(array, seed) {
    let random = () => seededRandom(seed++);
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// Cookie helpers
function setCookie(name, value, hours) {
    const expires = new Date(Date.now() + hours * 60 * 60 * 1000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`;
}
function getCookie(name) {
    const cookies = document.cookie.split(';');
    for (let c of cookies) {
        let [k, v] = c.trim().split('=');
        if (k === name) return decodeURIComponent(v || '');
    }
    return null;
}
function deleteCookie(name) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
}

// Helpers for saving/loading the question plan
function saveQuestionPlan(plan) {
    setCookie(PLAN_KEY, JSON.stringify({ v: 1, ...plan }), EXAM_COOKIE_HOURS);
}
function loadQuestionPlan() {
    const s = getCookie(PLAN_KEY);
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
}

const EXAM_COOKIE_HOURS = 3;

function saveExamState() {
    const state = {
        currentQuestionIndex,
        userAnswers,
        flaggedQuestions: Array.from(flaggedQuestions)
    };
    setCookie(STATE_KEY, JSON.stringify(state), EXAM_COOKIE_HOURS);
}

function loadExamState() {
    const stateStr = getCookie(STATE_KEY);
    if (!stateStr) return null;
    try {
        const state = JSON.parse(stateStr);
        return {
            currentQuestionIndex: state.currentQuestionIndex || 0,
            userAnswers: state.userAnswers || {},
            flaggedQuestions: new Set(state.flaggedQuestions || [])
        };
    } catch {
        return null;
    }
}

// Replace localStorage for timer
function saveExamStartTime(ts) {
    setCookie(STORAGE_KEY, ts.toString(), EXAM_COOKIE_HOURS);
}
function loadExamStartTime() {
    const val = getCookie(STORAGE_KEY);
    return val ? parseInt(val, 10) : null;
}
// End-time helpers ensure stable countdown across reloads
function saveExamEndTime(ts) {
    setCookie(END_TIME_KEY, ts.toString(), EXAM_COOKIE_HOURS);
}
function loadExamEndTime() {
    const val = getCookie(END_TIME_KEY);
    return val ? parseInt(val, 10) : null;
}

async function loadQuestions() {
    // Try to rebuild the questions list deterministically from a tiny plan
    const plan = loadQuestionPlan();

    try {
        const response = await fetch('questions.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const allQuestions = await response.json();

        if (allQuestions.length < TOTAL_QUESTIONS) {
            ui.showError(`Question pool has only ${allQuestions.length} questions. Exam requires exactly ${TOTAL_QUESTIONS}.`);
            questions = [];
            return;
        }

        if (plan) {
            // 1) Best: if we stored block IDs and the dataset still has those IDs, use them
            if (plan.blocksIds && Array.isArray(plan.blocksIds)) {
                const byId = new Map(allQuestions.map(q => [q.id, q]));
                const rebuiltBlocks = [];
                for (const blk of plan.blocksIds) {
                    if (!Array.isArray(blk)) continue;
                    const rebuilt = blk.map(id => byId.get(id)).filter(Boolean);
                    if (rebuilt.length === blk.length) rebuiltBlocks.push(rebuilt);
                }
                const flat = rebuiltBlocks.flat();
                if (flat.length > 0) {
                    questions = flat;
                    if (plan.optionsShuffles && Array.isArray(plan.optionsShuffles)) {
                        questions.forEach((q, idx) => {
                            const shuffle = plan.optionsShuffles[idx];
                            if (Array.isArray(shuffle) && Array.isArray(q.options)) {
                                const origOptions = [...q.options];
                                q.options = shuffle.map(i => origOptions[i]);
                            }
                        });
                    }
                    return;
                }
            }
            // 2) Next: if we stored IDs and the dataset still has those IDs, use them
            if (Array.isArray(plan.selectedIds) && plan.selectedIds.length === TOTAL_QUESTIONS) {
                const byId = new Map(allQuestions.map(q => [q.id, q]));
                const rebuilt = plan.selectedIds.map(id => byId.get(id)).filter(Boolean);
                if (rebuilt.length === TOTAL_QUESTIONS) {
                    questions = rebuilt;
                    // --- Apply optionsShuffles if present ---
                    if (plan.optionsShuffles && Array.isArray(plan.optionsShuffles)) {
                        questions.forEach((q, idx) => {
                            const shuffle = plan.optionsShuffles[idx];
                            if (Array.isArray(shuffle) && Array.isArray(q.options)) {
                                const origOptions = [...q.options];
                                q.options = shuffle.map(i => origOptions[i]);
                            }
                        });
                    }
                    return;
                }
                // IDs missing? fall through to indices/seed
            }

            // 2) Next best: indices against the same pool length
            if (
                Array.isArray(plan.selectedIndices) &&
                plan.selectedIndices.length === TOTAL_QUESTIONS &&
                (plan.poolLen == null || plan.poolLen === allQuestions.length) &&
                plan.selectedIndices.every(i => Number.isInteger(i) && i >= 0 && i < allQuestions.length)
            ) {
                questions = plan.selectedIndices.map(i => allQuestions[i]);
                // --- Apply optionsShuffles if present ---
                if (plan.optionsShuffles && Array.isArray(plan.optionsShuffles)) {
                    questions.forEach((q, idx) => {
                        const shuffle = plan.optionsShuffles[idx];
                        if (Array.isArray(shuffle) && Array.isArray(q.options)) {
                            const origOptions = [...q.options];
                            q.options = shuffle.map(i => origOptions[i]);
                        }
                    });
                }
                return;
            }

            // 3) Last resort: re-shuffle using the saved seed (works if the pool hasn’t changed)
            if (Number.isInteger(plan.seed)) {
                const allIdx = Array.from({ length: allQuestions.length }, (_, i) => i);
                shuffleArray(allIdx, plan.seed);
                questions = allIdx.slice(0, TOTAL_QUESTIONS).map(i => allQuestions[i]);
                // Restore options shuffles if present
                if (plan.optionsShuffles && Array.isArray(plan.optionsShuffles)) {
                    questions.forEach((q, idx) => {
                        const shuffle = plan.optionsShuffles[idx];
                        if (Array.isArray(shuffle) && Array.isArray(q.options)) {
                            const origOptions = [...q.options];
                            q.options = shuffle.map(i => origOptions[i]);
                        }
                    });
                }
                // Save canonical indices for stability on future reloads this sitting
                saveQuestionPlan({
                    seed: plan.seed,
                    selectedIndices: allIdx.slice(0, TOTAL_QUESTIONS),
                    selectedIds: questions.every(q => q && (typeof q.id === 'string' || typeof q.id === 'number'))
                        ? questions.map(q => q.id)
                        : null,
                    poolLen: allQuestions.length,
                    optionsShuffles: plan.optionsShuffles || null
                });
                return;
            }

            // No workable plan — require restart to avoid mismatched answers
            ui.showError("Exam session is invalid or expired. Please restart the exam.");
            questions = [];
            return;
        }

        // No plan — not started yet; load a non-random preview slice for the start screen
        // (Randomization only occurs in startExam())
        questions = allQuestions.slice(0, TOTAL_QUESTIONS);

    } catch (error) {
        console.error("Could not load questions:", error);
        ui.showError("Failed to load exam questions. Please try refreshing the page.");
        questions = [];
    }
}

export async function init() {
    await loadQuestions();
    const startTime = loadExamStartTime();
    if (startTime) {
        // Exam in progress, restore state
        const state = loadExamState();
        if (state) {
            currentQuestionIndex = state.currentQuestionIndex;
            // Deep clone userAnswers to avoid prototype issues
            userAnswers = Object.assign({}, state.userAnswers);
            // Ensure flaggedQuestions is a Set
            flaggedQuestions = new Set(state.flaggedQuestions instanceof Set ? Array.from(state.flaggedQuestions) : state.flaggedQuestions);
        }
        ui.showScreen('exam-screen');
        ui.createProgressBar(questions.length);
        showQuestion(currentQuestionIndex);
        startTimer();
    }
}

export function startExam() {
    // Always randomize and save questions when starting a new exam
    fetch('questions.json')
        .then(response => {
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return response.json();
        })
        .then(allQuestions => {
            if (allQuestions.length < TOTAL_QUESTIONS) {
                ui.showError(`Question pool has only ${allQuestions.length} questions. Exam requires exactly ${TOTAL_QUESTIONS}.`);
                return;
            }

            // Deterministic seed for this sitting
            const now = Date.now();
            const extra = Math.floor(Math.random() * 1000000);
            const seed = now ^ extra;

            // Build blocks for multipart groups and singles
            const byGroup = new Map();
            const singles = [];
            for (const q of allQuestions) {
                if (q && q.multipartGroupId) {
                    const gid = String(q.multipartGroupId);
                    if (!byGroup.has(gid)) byGroup.set(gid, []);
                    byGroup.get(gid).push(q);
                } else {
                    singles.push([q]);
                }
            }
            const groupBlocks = [];
            for (const [gid, arr] of byGroup.entries()) {
                const total = (arr[0] && Number(arr[0].multipartTotal)) || arr.length;
                const parts = arr.slice().sort((a,b)=> (a.multipartPart||0)-(b.multipartPart||0));
                const ok = parts.length === total && parts.every((q,i)=> Number(q.multipartPart) === i+1);
                if (!ok) {
                    console.warn('Invalid multipart group', gid, '— using as singles.');
                    parts.forEach(q=> groupBlocks.push([q]));
                } else {
                    groupBlocks.push(parts);
                }
            }
            // Shuffle groups and singles separately (deterministic)
            const groupIdx = Array.from({ length: groupBlocks.length }, (_, i) => i);
            shuffleArray(groupIdx, seed + 101);
            const singleIdx = Array.from({ length: singles.length }, (_, i) => i);
            shuffleArray(singleIdx, seed + 202);

            // Decide number of multipart groups to include: min 1, max 3 (bounded by availability)
            let pickedGroupBlocks = [];
            const maxGroups = Math.min(3, groupBlocks.length);
            if (groupBlocks.length > 0) {
                const desired = Math.max(1, Math.min(maxGroups, Math.floor(seededRandom(seed + 303) * maxGroups) + 1));
                let countPicked = 0;
                let tempCount = 0;
                for (const gi of groupIdx) {
                    const bl = groupBlocks[gi];
                    if (countPicked < desired && tempCount + bl.length <= TOTAL_QUESTIONS) {
                        pickedGroupBlocks.push(bl);
                        tempCount += bl.length;
                        countPicked++;
                    }
                    if (countPicked === desired) break;
                }
            }

            // Fill remaining questions with singles to hit TOTAL_QUESTIONS
            const pickedSingleBlocks = [];
            let count = pickedGroupBlocks.reduce((acc, b) => acc + b.length, 0);
            for (const si of singleIdx) {
                const bl = singles[si];
                if (count + bl.length <= TOTAL_QUESTIONS) {
                    pickedSingleBlocks.push(bl);
                    count += bl.length;
                }
                if (count === TOTAL_QUESTIONS) break;
            }

            // Interleave groups and singles by shuffling the final block order
            const finalBlocks = pickedGroupBlocks.concat(pickedSingleBlocks);
            const finalIdx = Array.from({ length: finalBlocks.length }, (_, i) => i);
            shuffleArray(finalIdx, seed + 404);
            const pickedBlocks = finalIdx.map(i => finalBlocks[i]);
            // Flatten to questions
            questions = pickedBlocks.flat();

            // Shuffle options for MCQ only (skip text and shuffleOptions=false)
            const optionsShuffles = [];
            questions.forEach((q, idx) => {
                if (Array.isArray(q.options) && q.options.length > 0 && q.shuffleOptions !== false) {
                    const origOptions = [...q.options];
                    const optionIndices = origOptions.map((_, i) => i);
                    shuffleArrayInPlace(optionIndices, seed + idx * 1000);
                    q.options = optionIndices.map(i => origOptions[i]);
                    optionsShuffles[idx] = optionIndices;
                } else {
                    optionsShuffles[idx] = null;
                }
            });

            // If questions have stable IDs, store them too (more robust if the server reorders the JSON)
            const selectedIds = questions.every(q => q && (typeof q.id === 'string' || typeof q.id === 'number'))
                ? questions.map(q => q.id)
                : null;

            // Save only the *plan*, not the bulky questions
            const blocksIds = pickedBlocks.map(bl => bl.map(q => q.id));
            saveQuestionPlan({
                seed,
                selectedIds,            // may be null if your data has no IDs
                poolLen: allQuestions.length,
                optionsShuffles,
                blocksIds
            });

            // Reset runtime state
            currentQuestionIndex = 0;
            userAnswers = {};
            flaggedQuestions.clear();

            // Store the start and end time in cookies
            const now2 = Date.now();
            saveExamStartTime(now2);
            saveExamEndTime(now2 + EXAM_DURATION * 1000);
            saveExamState();

            ui.showScreen('exam-screen');
            ui.createProgressBar(questions.length);
            showQuestion(currentQuestionIndex);
            startTimer();
        })
        .catch(error => {
            console.error("Could not load questions:", error);
            ui.showError("Failed to load exam questions. Please try refreshing the page.");
        });
}

function showQuestion(index) {
    if (index < 0 || index >= questions.length) return;
    currentQuestionIndex = index;
    const question = questions[index];

    ui.renderQuestion(question, userAnswers[index], index + 1, questions.length);
    ui.updateProgressBar(questions.length, userAnswers, flaggedQuestions, currentQuestionIndex);
    ui.updateFlagButton(flaggedQuestions.has(currentQuestionIndex));

    ui.prevBtn.disabled = index === 0;
    ui.nextBtn.disabled = index === questions.length - 1;
    scheduleSaveExamState();
}

export function selectAnswer(index, answer, isMulti = false) {
    if (!Array.isArray(userAnswers[index])) {
        userAnswers[index] = [];
    }
    if (isMulti) {
        if (userAnswers[index].includes(answer)) {
            userAnswers[index] = userAnswers[index].filter(a => a !== answer);
        } else {
            userAnswers[index].push(answer);
        }
    } else {
        userAnswers[index] = [answer];
    }
    ui.updateProgressBar(questions.length, userAnswers, flaggedQuestions, currentQuestionIndex);
    scheduleSaveExamState();
}

export function nextQuestion() {
    if (currentQuestionIndex < questions.length - 1) {
        showQuestion(currentQuestionIndex + 1);
    }
}

export function prevQuestion() {
    if (currentQuestionIndex > 0) {
        showQuestion(currentQuestionIndex - 1);
    }
}

export function goToQuestion(index) {
    // Ensure index is valid and update UI
    if (typeof index === 'number' && index >= 0 && index < questions.length) {
        showQuestion(index);
    }
    // else ignore invalid index
}

export function toggleFlag() {
    if (flaggedQuestions.has(currentQuestionIndex)) {
        flaggedQuestions.delete(currentQuestionIndex);
    } else {
        flaggedQuestions.add(currentQuestionIndex);
    }
    ui.updateFlagButton(flaggedQuestions.has(currentQuestionIndex));
    ui.updateProgressBar(questions.length, userAnswers, flaggedQuestions, currentQuestionIndex);
    scheduleSaveExamState();
}

function getTimeLeft() {
    // Prefer fixed end time for stability across reloads
    const endTime = loadExamEndTime();
    const now = Date.now();
    if (endTime && Number.isFinite(endTime)) {
        const remaining = Math.ceil((endTime - now) / 1000);
        return Math.max(remaining, 0);
    }
    // Fallback to start time if no end time recorded
    const startTime = loadExamStartTime();
    if (!startTime) return EXAM_DURATION;
    const elapsed = Math.floor((now - startTime) / 1000);
    return Math.max(EXAM_DURATION - elapsed, 0);
}

// Debounce state saves during rapid interactions
function scheduleSaveExamState() {
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
        saveExamState();
        saveStateTimer = null;
    }, 200);
}

function startTimer() {
    clearInterval(timerInterval);
    let timeLeft = getTimeLeft();
    ui.updateTimerDisplay(timeLeft, EXAM_DURATION);

    timerInterval = setInterval(() => {
        timeLeft = getTimeLeft();
        ui.updateTimerDisplay(timeLeft, EXAM_DURATION);
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            // Directly submit the exam, ignoring flagged/incomplete questions
            submitExam();
        }
    }, 1000);
}

export function handleSubmitAttempt() {
    if (flaggedQuestions.size > 0) {
        const sortedFlagged = [...flaggedQuestions].sort((a, b) => a - b);
        const flaggedDetails = sortedFlagged.map(index => ({
            index,
            text: questions[index].question
        }));
        ui.showFlaggedQuestionsModal(flaggedDetails);
    } else {
        const unansweredCount = questions.length - Object.keys(userAnswers).length;
        if (unansweredCount > 0) {
            // Warn, but allow submission if confirmed
            if (!confirm(`You have ${unansweredCount} unanswered question(s). Are you sure you want to submit?`)) {
                return;
            }
        } else if (!confirm('Are you sure you want to submit the exam?')) {
            return;
        }
        // Always call submitExam if confirmed
        submitExam();
    }
}

export function submitExam() {
    clearInterval(timerInterval);
    // Allow submission if there are questions loaded, but warn if not exactly 100
    if (!questions || questions.length === 0) {
        ui.showError(`Cannot submit: No questions loaded.`);
        return;
    }
    if (questions.length !== TOTAL_QUESTIONS) {
        ui.showError(`Warning: Exam does not have exactly ${TOTAL_QUESTIONS} questions. Results will be shown for ${questions.length} questions.`);
        // Continue to show results for whatever is loaded
    }
    clearExamCookies();
    ui.showScreen('results-screen');
    calculateResults();
}

// Helper to compare answers (supports both string and array)
function normalizeString(val, toLower = true) {
    if (val == null) return '';
    let s = String(val).trim();
    return toLower ? s.toLowerCase() : s;
}

function answersMatch(question, userAnswer, correctAnswer) {
    // Support array answers (multiple choice)
    if (Array.isArray(correctAnswer)) {
        if (!Array.isArray(userAnswer)) return false;
        if (userAnswer.length !== correctAnswer.length) return false;
        const a = [...userAnswer].sort();
        const b = [...correctAnswer].sort();
        return a.every((val, idx) => val === b[idx]);
    }

    // For single-answer questions, support text input normalization and numeric tolerance
    const q = question || {};
    const ua = Array.isArray(userAnswer) ? (userAnswer[0] ?? '') : (userAnswer ?? '');
    const ca = correctAnswer;

    // Metric-prefix-aware numeric matching (returns early when applicable)
    if (q && q.numeric) {
        const tol = typeof q.tolerance === 'number' ? q.tolerance : 0;
        const requireUnit = !!q.unitRequired || (Array.isArray(q.units) && q.units.length > 0) || typeof q.unit === 'string';
        const raw = String(ua).trim();
        let numStr = raw;
        let unitStr = '';
        const mNP = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*([\s\S]+))?$/);
        if (mNP) {
            numStr = mNP[1];
            unitStr = (mNP[2] || '').trim();
        }
        const parseUnit = (s) => {
            if (!s) return { base: '', factor: 1 };
            let u = String(s).trim()
                .replace(/[μµ]/g, 'u')
                .replace(/[Ωω]/g, 'ohm')
                .replace(/\s+/g, '')
                .toLowerCase();
            if (u === 'ohms') u = 'ohm';
            let base = '';
            let prefix = '';
            if (u.endsWith('ohm')) { base = 'ohm'; prefix = u.slice(0, -3); }
            else if (u.endsWith('henries')) { base = 'h'; prefix = u.slice(0, -7); }
            else if (u.endsWith('henry')) { base = 'h'; prefix = u.slice(0, -5); }
            else if (u.endsWith('farads')) { base = 'f'; prefix = u.slice(0, -6); }
            else if (u.endsWith('farad')) { base = 'f'; prefix = u.slice(0, -5); }
            else {
                const last = u.slice(-1);
                if (['a','v','f','h'].includes(last)) { base = last; prefix = u.slice(0, -1); }
                else if (u === 'ohm') { base = 'ohm'; prefix = ''; }
            }
            const prefMap = { '':1, 'k':1e3, 'm':1e-3, 'u':1e-6, 'n':1e-9, 'g':1e9, 't':1e12, 'mega':1e6, 'meg':1e6 };
            const factor = prefMap[prefix] != null ? prefMap[prefix] : 1;
            return { base, factor };
        };
        if (requireUnit) {
            if (!unitStr) return false;
            const acceptedList = Array.isArray(q.units) ? q.units : (q.unit ? [q.unit] : []);
            const canonPU = parseUnit(acceptedList[0] || '');
            const acceptedBases = new Set(acceptedList.map(u => parseUnit(u).base));
            const givenPU = parseUnit(unitStr);
            if (!acceptedBases.has(givenPU.base)) return false;
            const uNum = parseFloat(numStr.replace(/,/g, ''));
            const cNum = parseFloat(String(ca).replace(/,/g, ''));
            if (!Number.isFinite(uNum) || !Number.isFinite(cNum)) return false;
            const uInCanon = (uNum * (givenPU.factor || 1)) / ((canonPU.factor || 1));
            return Math.abs(uInCanon - cNum) <= Math.abs(cNum) * tol;
        }
        const uNum = parseFloat(numStr.replace(/,/g, ''));
        const cNum = parseFloat(String(ca).replace(/,/g, ''));
        if (!Number.isFinite(uNum) || !Number.isFinite(cNum)) return false;
        return Math.abs(uNum - cNum) <= Math.abs(cNum) * tol;
    }

    // Numeric matching with tolerance
    if (q && q.numeric) {
        const tol = typeof q.tolerance === 'number' ? q.tolerance : 0;
        const requireUnit = !!q.unitRequired || (Array.isArray(q.units) && q.units.length > 0);

        // Extract numeric part and unit part
        const raw = String(ua).trim();
        let numStr = raw;
        let unitStr = '';
        const m = raw.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(?:\s*([\s\S]+))?$/);
        if (m) {
            numStr = m[1];
            unitStr = (m[2] || '').trim();
        }

        if (requireUnit) {
            if (!unitStr) return false; // unit required but missing
            const norm = s => s
                .toLowerCase()
                .replace(/[μµ]/g, 'u')
                .replace(/[Ωω]/g, 'ohm')
                .replace(/[^a-z0-9]/g, '');
            const given = norm(unitStr);
            const accepted = new Set((Array.isArray(q.units) ? q.units : [q.unit]).filter(Boolean).map(norm));
            // Common synonyms auto-accepted if units not explicitly provided
            if (accepted.size === 0) {
                ['a','amp','amps','ampere','amperes','v','volt','volts','ohm','omega','uf','µf','mf','nf','pf','ka','kv'].forEach(u => accepted.add(norm(u)));
            }
            // Map common synonyms
            const mapSyn = s => {
                if (s === 'ohms') return 'ohm';
                if (s === 'amp' || s === 'amps' || s === 'ampere' || s === 'amperes') return 'a';
                if (s === 'volt' || s === 'volts') return 'v';
                if (s === 'µf') return 'uf';
                return s;
            };
            const normalizedGiven = mapSyn(given);
            // accept if exact match to any normalized accepted unit
            const normalizedAccepted = new Set(Array.from(accepted).map(mapSyn));
            if (!normalizedAccepted.has(normalizedGiven)) return false;
        }

        const uNum = parseFloat(numStr.replace(/,/g, ''));
        const cNum = parseFloat(String(ca).replace(/,/g, ''));
        if (!Number.isFinite(uNum) || !Number.isFinite(cNum)) return false;
        return Math.abs(uNum - cNum) <= Math.abs(cNum) * tol;
    }

    // Acceptable string answers set
    if (q && Array.isArray(q.acceptableAnswers)) {
        const set = new Set(q.acceptableAnswers.map(a => normalizeString(a)));
        return set.has(normalizeString(ua));
    }

    // Fallback exact string (case-insensitive, trimmed)
    return normalizeString(ua) === normalizeString(ca);
}

function calculateResults() {
    let correctAnswers = 0;
    const results = questions.map((question, index) => {
        const userAnswer = userAnswers[index];
        const correctAnswer = question.answer;
        const isCorrect = answersMatch(question, userAnswer, correctAnswer);
        // Determine note for missing units on incorrect numeric answers
        let note = null;
        if (!isCorrect && question && question.numeric) {
            const requireUnit = !!question.unitRequired || (Array.isArray(question.units) && question.units.length > 0) || typeof question.unit === 'string';
            if (requireUnit) {
                const ua = Array.isArray(userAnswer) ? (userAnswer && userAnswer[0]) : userAnswer;
                const raw = (ua == null) ? '' : String(ua);
                const m = raw.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*([\s\S]+))?$/);
                const unitStr = m ? (m[2] || '').trim() : '';
                if (!unitStr) {
                    note = 'Units missing or not entered.';
                }
            }
        }
        if (isCorrect) {
            correctAnswers++;
        }
        // Format user and correct answers for display
        const userAnswerDisplay = Array.isArray(userAnswer)
            ? (userAnswer.length ? userAnswer.join(', ') : 'Not answered')
            : (userAnswer || 'Not answered');
        const correctAnswerDisplay = Array.isArray(correctAnswer)
            ? correctAnswer.join(', ')
            : correctAnswer;
        return {
            question: question.question,
            userAnswer: userAnswerDisplay,
            correctAnswer: correctAnswerDisplay,
            isCorrect,
            reference: question.reference, // Pass reference to UI
            note
        };
    });

    const percentage = Math.round((correctAnswers / questions.length) * 100);
    ui.renderResults(percentage, correctAnswers, questions.length, results);
}

// Export a small test helper for text comparison
export function __compareAnswerForTest(question, userValue) {
    const ua = [userValue];
    const ok = answersMatch(question, ua, question.answer);
    return { ok };
}

export function restartExam() {
    clearInterval(timerInterval);
    clearExamCookies();
    // Clear all state
    currentQuestionIndex = 0;
    userAnswers = {};
    flaggedQuestions.clear();
    questions = [];

    // Reload questions for a fresh start (will fetch and not randomize, but startExam will randomize)
    loadQuestions().then(() => {
        ui.showScreen('start-screen');
    }).catch(error => {
        console.error("Failed to reload questions after restart:", error);
        ui.showError("Failed to reload questions. Please refresh the page.");
    });
}

// Add this helper to clear all exam cookies
function clearExamCookies() {
    deleteCookie(STORAGE_KEY);
    deleteCookie(END_TIME_KEY);
    deleteCookie(STATE_KEY);
    deleteCookie(QUESTIONS_KEY);
    deleteCookie(PLAN_KEY);
}
