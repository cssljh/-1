/**
 * 초등학생 디지털 시민성 퀴즈 애플리케이션 핵심 로직 및 구글 앱스 스크립트(GAS) 연동 스크립트
 * 
 * 주요 기능:
 * 1. 완전한 익명 보장 (개인정보 일절 수집 없음, 귀여운 랜덤 동물 별명 자동 생성)
 * 2. 퀴즈 진행 관리 (문항 렌더링, 1~10번 진행률)
 * 3. 4지선다 즉각적인 정오답 판정 및 친절한 해설 피드백
 * 4. Web Audio API 내장 효과음 (정답/오답/축하 팡파르, 외부 파일 의존 없음)
 * 5. 결과 화면 (총점, 칭찬 메시지, 오답 복습 필터링 기능)
 * 6. 구글 앱스 스크립트(GAS) 자동 전송 (fetch POST, CORS 회피 최적화)
 * 7. 선생님 전용 GAS Web App URL 간편 설정 모달
 */

// ==========================================
// 1. 전역 설정 및 상태 변수
// ==========================================

// [선생님 설정용] 기본 구글 앱스 스크립트 Web App URL
// 배포 후 생성된 URL을 아래 따옴표 안에 넣거나, 웹 화면 우측 상단의 '⚙️ 선생님 연동 설정' 메뉴에서 등록할 수 있습니다.
const DEFAULT_GAS_URL = "";

// 로컬 스토리지 키
const STORAGE_KEY_GAS_URL = "DIGITAL_CITIZEN_GAS_URL";
const STORAGE_KEY_SOUND = "DIGITAL_CITIZEN_SOUND_ENABLED";

// 퀴즈 상태 객체
const QuizState = {
  currentIndex: 0,
  userAnswers: [], // 각 문항별 사용자가 선택한 보기 인덱스 (0~3)
  results: [],     // 채점 결과 { id, topic, isCorrect, userAnswerIndex, correctAnswerIndex }
  isAnswered: false,
  anonymousNickname: "",
  soundEnabled: true,
  filterMode: "all", // 'all' or 'wrong'
  startTime: null,
  endTime: null
};

// 귀여운 익명 별명 수식어 및 동물 목록 (개인정보 100% 배제)
const NICKNAME_ADJECTIVES = [
  "지혜로운", "용감한", "친절한", "성실한", "배려하는", 
  "정직한", "슬기로운", "따뜻한", "책임감있는", "눈부신",
  "멋진", "안전한", "든든한", "바른말하는", "정의로운"
];

const NICKNAME_ANIMALS = [
  { name: "올빼미", icon: "🦉" },
  { name: "돌고래", icon: "🐬" },
  { name: "호랑이", icon: "🐯" },
  { name: "판다", icon: "🐼" },
  { name: "사자", icon: "🦁" },
  { name: "다람쥐", icon: "🐿️" },
  { name: "수달", icon: "🦦" },
  { name: "코알라", icon: "🐨" },
  { name: "독수리", icon: "🦅" },
  { name: "토끼", icon: "🐰" }
];

// ==========================================
// 2. 효과음 생성기 (Web Audio API)
// ==========================================
class SoundController {
  constructor() {
    this.ctx = null;
  }

  initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  playTone(freq, duration, type = "sine", gainValue = 0.15, delay = 0) {
    if (!QuizState.soundEnabled) return;
    this.initContext();
    if (!this.ctx) return;

    setTimeout(() => {
      try {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

        gain.gain.setValueAtTime(gainValue, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + duration);
      } catch (e) {
        console.warn("효과음 재생 오류:", e);
      }
    }, delay * 1000);
  }

  // 정답 효과음 (맑고 경쾌한 2화음 딩동~)
  playCorrect() {
    this.playTone(523.25, 0.18, "triangle", 0.15, 0);     // C5
    this.playTone(659.25, 0.28, "triangle", 0.18, 0.1);   // E5
    this.playTone(783.99, 0.40, "sine", 0.20, 0.2);       // G5
  }

  // 오답 효과음 (부드러운 띠로롱)
  playIncorrect() {
    this.playTone(392.00, 0.15, "sawtooth", 0.10, 0);     // G4
    this.playTone(311.13, 0.35, "sawtooth", 0.12, 0.12);  // Eb4
  }

  // 완료 팡파르
  playVictory() {
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, idx) => {
      this.playTone(freq, 0.25, "triangle", 0.15, idx * 0.12);
    });
    this.playTone(1046.50, 0.7, "sine", 0.22, 0.52);
  }
}

const soundCtrl = new SoundController();

// ==========================================
// 3. 익명 별명 생성 함수
// ==========================================
function generateRandomNickname() {
  const adj = NICKNAME_ADJECTIVES[Math.floor(Math.random() * NICKNAME_ADJECTIVES.length)];
  const animal = NICKNAME_ANIMALS[Math.floor(Math.random() * NICKNAME_ANIMALS.length)];
  const randomNum = Math.floor(100 + Math.random() * 900); // 3자리 숫자
  return {
    fullName: `${adj} ${animal.name} #${randomNum}`,
    icon: animal.icon
  };
}

function updateNicknameUI() {
  const nick = generateRandomNickname();
  QuizState.anonymousNickname = nick.fullName;
  const badgeEl = document.getElementById("anonymous-nickname-badge");
  if (badgeEl) {
    badgeEl.innerHTML = `<span class="text-xl mr-1.5">${nick.icon}</span><span class="font-bold text-indigo-700">${nick.fullName}</span>`;
  }
}

// ==========================================
// 4. 화면 전환 및 퀴즈 흐름 제어
// ==========================================

function switchScreen(screenName) {
  const screens = ["intro", "quiz", "result"];
  screens.forEach(name => {
    const el = document.getElementById(`screen-${name}`);
    if (el) {
      if (name === screenName) {
        el.classList.remove("hidden");
        el.classList.add("block");
      } else {
        el.classList.add("hidden");
        el.classList.remove("block");
      }
    }
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function startQuiz() {
  soundCtrl.initContext();
  if (!QuizState.anonymousNickname) {
    updateNicknameUI();
  }
  QuizState.currentIndex = 0;
  QuizState.userAnswers = [];
  QuizState.results = [];
  QuizState.isAnswered = false;
  QuizState.startTime = new Date();

  switchScreen("quiz");
  renderQuestion(QuizState.currentIndex);
}

function renderQuestion(index) {
  const questions = window.QUIZ_QUESTIONS;
  if (!questions || index >= questions.length) {
    finishQuiz();
    return;
  }

  const q = questions[index];
  QuizState.isAnswered = false;

  // 1. 진행도 업데이트
  const progressText = document.getElementById("quiz-progress-text");
  const progressBar = document.getElementById("quiz-progress-bar");
  const total = questions.length;
  const currentNum = index + 1;
  const percentage = Math.round((currentNum / total) * 100);

  if (progressText) progressText.innerText = `문항 ${currentNum} / ${total}`;
  if (progressBar) progressBar.style.width = `${percentage}%`;

  // 2. 주제 배지 업데이트
  const topicBadge = document.getElementById("quiz-topic-badge");
  if (topicBadge) {
    topicBadge.innerHTML = `<i class="fa-solid ${q.topicIcon} mr-1.5"></i><span>${q.topic}</span>`;
    topicBadge.className = `inline-flex items-center px-3 py-1 rounded-full text-xs sm:text-sm font-semibold border ${q.topicColor}`;
  }

  // 3. 문항 제목 렌더링
  const questionTitle = document.getElementById("quiz-question-title");
  if (questionTitle) {
    questionTitle.innerHTML = `<span class="inline-block bg-indigo-600 text-white font-black text-sm px-2.5 py-0.5 rounded-lg mr-2 align-middle shadow-sm">Q${q.id}</span>${escapeHtml(q.question)}`;
  }

  // 4. 보기 버튼 렌더링
  const optionsContainer = document.getElementById("quiz-options-container");
  if (optionsContainer) {
    optionsContainer.innerHTML = "";
    const optionLabels = ["①", "②", "③", "④"];

    q.options.forEach((optText, optIdx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `option-btn w-full text-left p-4 sm:p-5 rounded-2xl border-2 border-slate-200 bg-white hover:border-indigo-400 hover:bg-indigo-50/50 transition-all duration-200 flex items-start gap-3.5 group shadow-sm active:scale-[0.99]`;
      btn.onclick = () => selectOption(optIdx);

      btn.innerHTML = `
        <span class="option-badge flex-shrink-0 w-8 h-8 rounded-xl bg-slate-100 group-hover:bg-indigo-600 group-hover:text-white font-bold text-slate-600 text-sm flex items-center justify-center transition-colors">
          ${optionLabels[optIdx]}
        </span>
        <span class="option-text text-slate-800 text-base sm:text-lg font-medium leading-relaxed pt-0.5 flex-1">
          ${escapeHtml(optText)}
        </span>
        <span class="option-status-icon hidden flex-shrink-0 w-7 h-7 rounded-full items-center justify-center text-sm font-bold"></span>
      `;
      optionsContainer.appendChild(btn);
    });
  }

  // 5. 피드백 영역 숨김 처리
  const feedbackBox = document.getElementById("quiz-feedback-box");
  if (feedbackBox) {
    feedbackBox.classList.add("hidden");
    feedbackBox.className = "hidden mt-6 p-5 sm:p-6 rounded-2xl border transition-all duration-300";
  }

  // 6. 다음 버튼 숨김 처리
  const nextBtn = document.getElementById("quiz-next-btn");
  if (nextBtn) {
    nextBtn.classList.add("hidden");
    // 마지막 문제일 경우 버튼 텍스트 변경
    if (index === total - 1) {
      nextBtn.innerHTML = `<span>결과 확인하기</span><i class="fa-solid fa-trophy ml-2"></i>`;
      nextBtn.className = "w-full py-4 px-6 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-bold text-lg shadow-lg hover:shadow-xl transition-all duration-200 flex items-center justify-center";
    } else {
      nextBtn.innerHTML = `<span>다음 문제로</span><i class="fa-solid fa-arrow-right ml-2"></i>`;
      nextBtn.className = "w-full py-4 px-6 rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-bold text-lg shadow-lg hover:shadow-xl transition-all duration-200 flex items-center justify-center";
    }
  }
}

// 보기 선택 시 즉각적인 피드백 처리
function selectOption(selectedIndex) {
  if (QuizState.isAnswered) return;
  QuizState.isAnswered = true;

  const questions = window.QUIZ_QUESTIONS;
  const currentQ = questions[QuizState.currentIndex];
  const isCorrect = (selectedIndex === currentQ.answer);

  // 결과 저장
  QuizState.userAnswers.push(selectedIndex);
  QuizState.results.push({
    id: currentQ.id,
    topic: currentQ.topic,
    question: currentQ.question,
    options: currentQ.options,
    isCorrect: isCorrect,
    userAnswerIndex: selectedIndex,
    correctAnswerIndex: currentQ.answer,
    explanation: currentQ.explanation
  });

  // 버튼 스타일 업데이트
  const optionsContainer = document.getElementById("quiz-options-container");
  const buttons = optionsContainer.querySelectorAll(".option-btn");

  buttons.forEach((btn, idx) => {
    btn.disabled = true;
    btn.classList.remove("hover:border-indigo-400", "hover:bg-indigo-50/50", "active:scale-[0.99]");
    btn.classList.add("cursor-default");

    const badge = btn.querySelector(".option-badge");
    const statusIcon = btn.querySelector(".option-status-icon");

    if (idx === currentQ.answer) {
      // 정답 표시 (녹색 하이라이트)
      btn.classList.remove("border-slate-200", "bg-white");
      btn.classList.add("border-emerald-500", "bg-emerald-50/70", "ring-2", "ring-emerald-200");
      badge.classList.add("bg-emerald-600", "text-white");
      statusIcon.classList.remove("hidden");
      statusIcon.classList.add("flex", "bg-emerald-500", "text-white");
      statusIcon.innerHTML = `<i class="fa-solid fa-check"></i>`;
    } else if (idx === selectedIndex && !isCorrect) {
      // 사용자가 고른 오답 표시 (붉은색 하이라이트)
      btn.classList.remove("border-slate-200", "bg-white");
      btn.classList.add("border-rose-400", "bg-rose-50/70", "ring-2", "ring-rose-200");
      badge.classList.add("bg-rose-500", "text-white");
      statusIcon.classList.remove("hidden");
      statusIcon.classList.add("flex", "bg-rose-500", "text-white");
      statusIcon.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
    } else {
      // 나머지 보기 딤 처리
      btn.classList.add("opacity-60");
    }
  });

  // 효과음 재생
  if (isCorrect) {
    soundCtrl.playCorrect();
  } else {
    soundCtrl.playIncorrect();
  }

  // 피드백 박스 렌더링
  const feedbackBox = document.getElementById("quiz-feedback-box");
  if (feedbackBox) {
    feedbackBox.classList.remove("hidden");
    if (isCorrect) {
      feedbackBox.className = "mt-6 p-5 sm:p-6 rounded-2xl border-2 border-emerald-300 bg-emerald-50/80 animate-fade-in";
      feedbackBox.innerHTML = `
        <div class="flex items-center gap-3 mb-2.5">
          <div class="w-9 h-9 rounded-xl bg-emerald-500 text-white flex items-center justify-center text-lg shadow-sm">
            <i class="fa-solid fa-circle-check"></i>
          </div>
          <div>
            <h4 class="font-bold text-emerald-900 text-lg">정답입니다! 참 잘했어요! 🎉</h4>
            <p class="text-emerald-700 text-xs sm:text-sm font-medium">올바른 디지털 시민의 자세를 아주 잘 알고 있네요.</p>
          </div>
        </div>
        <div class="bg-white/80 rounded-xl p-4 border border-emerald-200/60 mt-3">
          <p class="text-xs font-bold text-emerald-800 uppercase tracking-wider mb-1 flex items-center gap-1.5">
            <i class="fa-solid fa-lightbulb text-amber-500"></i> 친절한 핵심 해설
          </p>
          <p class="text-slate-700 text-sm sm:text-base leading-relaxed">${escapeHtml(currentQ.explanation)}</p>
        </div>
      `;
    } else {
      feedbackBox.className = "mt-6 p-5 sm:p-6 rounded-2xl border-2 border-rose-300 bg-rose-50/80 animate-fade-in";
      feedbackBox.innerHTML = `
        <div class="flex items-center gap-3 mb-2.5">
          <div class="w-9 h-9 rounded-xl bg-rose-500 text-white flex items-center justify-center text-lg shadow-sm">
            <i class="fa-solid fa-triangle-exclamation"></i>
          </div>
          <div>
            <h4 class="font-bold text-rose-900 text-lg">아쉬워요! 다시 꼭 기억해 볼까요? 💡</h4>
            <p class="text-rose-700 text-xs sm:text-sm font-medium">정답은 <strong class="underline decoration-2 text-rose-900 font-extrabold">[${["①", "②", "③", "④"][currentQ.answer]} ${escapeHtml(currentQ.options[currentQ.answer])}]</strong> 입니다.</p>
          </div>
        </div>
        <div class="bg-white/80 rounded-xl p-4 border border-rose-200/60 mt-3">
          <p class="text-xs font-bold text-rose-800 uppercase tracking-wider mb-1 flex items-center gap-1.5">
            <i class="fa-solid fa-book-open text-rose-500"></i> 왜 그럴까요? 친절한 해설
          </p>
          <p class="text-slate-700 text-sm sm:text-base leading-relaxed">${escapeHtml(currentQ.explanation)}</p>
        </div>
      `;
    }
  }

  // 다음 버튼 노출
  const nextBtn = document.getElementById("quiz-next-btn");
  if (nextBtn) {
    nextBtn.classList.remove("hidden");
  }
}

// 다음 문제 버튼 클릭 시 호출
function handleNextQuestion() {
  QuizState.currentIndex++;
  const questions = window.QUIZ_QUESTIONS;
  if (QuizState.currentIndex < questions.length) {
    renderQuestion(QuizState.currentIndex);
  } else {
    finishQuiz();
  }
}

// ==========================================
// 5. 퀴즈 완료 및 결과 화면
// ==========================================

function finishQuiz() {
  QuizState.endTime = new Date();
  const total = QuizState.results.length;
  const correctCount = QuizState.results.filter(r => r.isCorrect).length;
  const scorePercent = Math.round((correctCount / total) * 100);

  switchScreen("result");

  // 축하 팡파르 및 색종이 효과
  soundCtrl.playVictory();
  triggerCelebrationConfetti(correctCount);

  // 결과 화면 UI 바인딩
  const scoreNumberEl = document.getElementById("result-score-number");
  const scoreTotalEl = document.getElementById("result-score-total");
  const scorePercentEl = document.getElementById("result-score-percent");
  const praiseTitleEl = document.getElementById("result-praise-title");
  const praiseDescEl = document.getElementById("result-praise-desc");
  const badgeCardEl = document.getElementById("result-badge-card");

  if (scoreNumberEl) scoreNumberEl.innerText = correctCount;
  if (scoreTotalEl) scoreTotalEl.innerText = ` / ${total}점`;
  if (scorePercentEl) scorePercentEl.innerText = `${scorePercent}점`;

  // 점수대별 칭찬 메시지 & 배지
  let praise = {
    badge: "🏆 디지털 시민 수호 마스터",
    badgeColor: "from-amber-400 to-amber-600 text-white",
    title: "완벽해요! 디지털 세상을 밝히는 최고 영웅! 🌟",
    desc: "10문항을 모두 멋지게 해결했어요! 올바른 디지털 에티켓과 안전 수칙을 완벽하게 실천하고 있군요. 친구들에게도 모범이 되는 최고의 디지털 시민입니다."
  };

  if (correctCount === 10) {
    // 만점
  } else if (correctCount >= 8) {
    praise = {
      badge: "🥇 모범 디지털 시민",
      badgeColor: "from-emerald-400 to-teal-600 text-white",
      title: "참 잘했어요! 믿음직한 디지털 리더! 👏",
      desc: "대부분의 디지털 안전 수칙을 잘 이해하고 있어요! 헷갈렸던 문제만 한 번 더 짚고 넘어가면 완벽한 디지털 수호자가 될 수 있습니다."
    };
  } else if (correctCount >= 6) {
    praise = {
      badge: "🥈 슬기로운 디지털 탐험가",
      badgeColor: "from-indigo-400 to-blue-600 text-white",
      title: "멋진 도전이에요! 성장하는 디지털 시민! 🌱",
      desc: "디지털 세계를 안전하게 탐험할 준비가 되어 가고 있네요. 아래 복습 영역에서 해설을 읽어보고 다시 만점에 도전해 보세요!"
    };
  } else {
    praise = {
      badge: "🥉 새싹 디지털 꿈나무",
      badgeColor: "from-violet-400 to-purple-600 text-white",
      title: "괜찮아요! 지금부터 배우면 돼요! 💪",
      desc: "처음에는 헷갈릴 수 있는 내용들이에요. 오늘 배운 10가지 규칙만 잘 기억해도 안전한 디지털 생활을 할 수 있습니다. 차근차근 복습해 봐요!"
    };
  }

  if (badgeCardEl) {
    badgeCardEl.innerHTML = `
      <span class="inline-block px-4 py-1.5 rounded-full text-sm sm:text-base font-extrabold bg-gradient-to-r ${praise.badgeColor} shadow-md tracking-wide">
        ${praise.badge}
      </span>
    `;
  }
  if (praiseTitleEl) praiseTitleEl.innerText = praise.title;
  if (praiseDescEl) praiseDescEl.innerText = praise.desc;

  // 익명 닉네임 표시
  const resultNicknameEl = document.getElementById("result-student-nickname");
  if (resultNicknameEl) {
    resultNicknameEl.innerText = QuizState.anonymousNickname;
  }

  // 복습 목록 렌더링
  renderReviewList("all");

  // 구글 앱스 스크립트(GAS) 자동 전송
  sendResultsToGAS(correctCount, total, scorePercent);
}

// 색종이 가루(Confetti) 축하 효과
function triggerCelebrationConfetti(score) {
  if (typeof confetti === "function") {
    try {
      const count = score >= 8 ? 120 : 60;
      confetti({
        particleCount: count,
        spread: 80,
        origin: { y: 0.6 }
      });
      if (score === 10) {
        setTimeout(() => {
          confetti({
            particleCount: 80,
            angle: 60,
            spread: 55,
            origin: { x: 0 }
          });
          confetti({
            particleCount: 80,
            angle: 120,
            spread: 55,
            origin: { x: 1 }
          });
        }, 300);
      }
    } catch (e) {
      console.log("Confetti anim skipped", e);
    }
  }
}

// 복습 목록 렌더링 (전체 / 오답만 보기)
function renderReviewList(filter = "all") {
  QuizState.filterMode = filter;
  const container = document.getElementById("result-review-container");
  if (!container) return;

  // 필터 탭 버튼 스타일 갱신
  const tabAll = document.getElementById("tab-review-all");
  const tabWrong = document.getElementById("tab-review-wrong");
  const wrongCount = QuizState.results.filter(r => !r.isCorrect).length;

  if (tabAll && tabWrong) {
    if (filter === "all") {
      tabAll.className = "px-4 py-2 rounded-xl text-sm font-bold bg-indigo-600 text-white shadow-sm";
      tabWrong.className = "px-4 py-2 rounded-xl text-sm font-bold bg-slate-100 text-slate-600 hover:bg-slate-200";
    } else {
      tabAll.className = "px-4 py-2 rounded-xl text-sm font-bold bg-slate-100 text-slate-600 hover:bg-slate-200";
      tabWrong.className = "px-4 py-2 rounded-xl text-sm font-bold bg-rose-600 text-white shadow-sm";
    }
    tabWrong.innerHTML = `<span>내가 틀린 문제 (${wrongCount})</span>`;
  }

  // 필터링 적용
  let list = QuizState.results;
  if (filter === "wrong") {
    list = list.filter(r => !r.isCorrect);
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12 bg-emerald-50/50 rounded-2xl border border-emerald-200">
        <div class="text-4xl mb-2">🎉</div>
        <h4 class="font-bold text-emerald-900 text-lg">틀린 문제가 하나도 없습니다!</h4>
        <p class="text-emerald-700 text-sm mt-1">완벽하게 모든 디지털 시민성 문제를 마스터하셨습니다.</p>
      </div>
    `;
    return;
  }

  const optionLabels = ["①", "②", "③", "④"];
  container.innerHTML = "";

  list.forEach((item) => {
    const card = document.createElement("div");
    card.className = `p-5 sm:p-6 rounded-2xl border-2 transition-all ${
      item.isCorrect ? "border-emerald-200 bg-white" : "border-rose-200 bg-rose-50/30"
    } shadow-sm`;

    const statusBadge = item.isCorrect
      ? `<span class="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300"><i class="fa-solid fa-check"></i> 정답</span>`
      : `<span class="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-extrabold bg-rose-100 text-rose-800 border border-rose-300"><i class="fa-solid fa-xmark"></i> 오답</span>`;

    card.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2">
          <span class="w-7 h-7 rounded-lg bg-indigo-100 text-indigo-700 font-extrabold text-sm flex items-center justify-center">Q${item.id}</span>
          <span class="text-xs font-bold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">${escapeHtml(item.topic)}</span>
        </div>
        <div>${statusBadge}</div>
      </div>

      <h4 class="text-slate-900 font-bold text-base sm:text-lg mb-3 leading-snug">
        ${escapeHtml(item.question)}
      </h4>

      <div class="grid grid-cols-1 gap-2 my-3 text-sm">
        ${item.options.map((opt, optIdx) => {
          let optStyle = "border-slate-200 bg-slate-50 text-slate-700";
          let labelBadge = "";

          if (optIdx === item.correctAnswerIndex) {
            optStyle = "border-emerald-400 bg-emerald-50 text-emerald-950 font-bold ring-1 ring-emerald-300";
            labelBadge = `<span class="ml-auto text-xs px-2 py-0.5 rounded bg-emerald-600 text-white font-bold">정답</span>`;
          } else if (optIdx === item.userAnswerIndex && !item.isCorrect) {
            optStyle = "border-rose-300 bg-rose-50 text-rose-950 font-semibold";
            labelBadge = `<span class="ml-auto text-xs px-2 py-0.5 rounded bg-rose-500 text-white font-bold">내가 고른 답</span>`;
          }

          return `
            <div class="flex items-center gap-2.5 p-3 rounded-xl border ${optStyle}">
              <span class="font-bold flex-shrink-0">${optionLabels[optIdx]}</span>
              <span class="leading-relaxed flex-1">${escapeHtml(opt)}</span>
              ${labelBadge}
            </div>
          `;
        }).join("")}
      </div>

      <div class="mt-4 p-4 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 text-xs sm:text-sm leading-relaxed">
        <span class="font-bold text-indigo-700 flex items-center gap-1.5 mb-1">
          <i class="fa-solid fa-circle-info"></i> 해설
        </span>
        ${escapeHtml(item.explanation)}
      </div>
    `;

    container.appendChild(card);
  });
}

// ==========================================
// 6. 구글 앱스 스크립트(GAS) 자동 전송
// ==========================================

function getEffectiveGASUrl() {
  const savedUrl = localStorage.getItem(STORAGE_KEY_GAS_URL);
  if (savedUrl && savedUrl.trim().length > 0) {
    return savedUrl.trim();
  }
  return DEFAULT_GAS_URL.trim();
}

async function sendResultsToGAS(score, total, percentage) {
  const statusEl = document.getElementById("gas-status-banner");
  const gasUrl = getEffectiveGASUrl();

  // 문항별 O/X 매핑 (스프레드시트 열 매핑용)
  const qMap = {};
  QuizState.results.forEach((r, idx) => {
    qMap[`q${idx + 1}`] = r.isCorrect ? "O" : "X";
  });

  const payload = {
    timestamp: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
    nickname: QuizState.anonymousNickname, // 완전한 익명 보장 (개인정보 없음)
    score: score,
    total: total,
    percentage: percentage,
    durationSeconds: QuizState.startTime && QuizState.endTime ? Math.round((QuizState.endTime - QuizState.startTime) / 1000) : 0,
    ...qMap
  };

  // 1. URL이 설정되지 않은 경우
  if (!gasUrl || gasUrl.length < 10) {
    if (statusEl) {
      statusEl.className = "p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs sm:text-sm flex items-start gap-3";
      statusEl.innerHTML = `
        <i class="fa-solid fa-circle-exclamation text-amber-500 text-lg flex-shrink-0 mt-0.5"></i>
        <div class="flex-1">
          <p class="font-bold mb-0.5">구글 스프레드시트 연동 준비 완료 (로컬 채점 완료)</p>
          <p class="text-amber-700 leading-relaxed">선생님 스프레드시트 URL이 아직 등록되지 않아 학생 PC에서만 결과를 확인했습니다. 상단 <strong>[⚙️ 선생님 연동 설정]</strong> 메뉴에서 웹 앱 URL을 등록하시면 제출 기록이 구글 시트에 실시간 자동 누적됩니다.</p>
        </div>
      `;
    }
    console.log("[익명 전송 대기] GAS URL 미설정 - 전송 페이로드 확인:", payload);
    return;
  }

  // 2. GAS 웹 앱으로 전송 중 UI
  if (statusEl) {
    statusEl.className = "p-4 rounded-2xl bg-indigo-50 border border-indigo-200 text-indigo-900 text-xs sm:text-sm flex items-center gap-3";
    statusEl.innerHTML = `
      <i class="fa-solid fa-spinner fa-spin text-indigo-600 text-lg flex-shrink-0"></i>
      <p class="font-medium">구글 스프레드시트로 익명 결과를 안전하게 전송하는 중입니다...</p>
    `;
  }

  try {
    // Google Apps Script는 302 리디렉션을 발생시키므로 mode: "no-cors" 사용이 필수입니다.
    await fetch(gasUrl, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    if (statusEl) {
      statusEl.className = "p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs sm:text-sm flex items-center gap-3";
      statusEl.innerHTML = `
        <i class="fa-solid fa-cloud-arrow-up text-emerald-600 text-lg flex-shrink-0"></i>
        <div>
          <span class="font-bold">선생님 구글 스프레드시트에 안전하게 자동 기록되었습니다!</span>
          <span class="text-emerald-700 text-xs block mt-0.5">제출 시각: ${payload.timestamp} (개인정보는 절대 포함되지 않습니다)</span>
        </div>
      `;
    }
    console.log("[익명 전송 성공] 구글 스프레드시트로 전송 완료:", payload);
  } catch (error) {
    console.warn("GAS 전송 실패:", error);
    if (statusEl) {
      statusEl.className = "p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs sm:text-sm flex items-start gap-3";
      statusEl.innerHTML = `
        <i class="fa-solid fa-wifi text-amber-600 text-lg flex-shrink-0 mt-0.5"></i>
        <div>
          <p class="font-bold">네트워크 연결 상태 확인</p>
          <p class="text-amber-700 text-xs mt-0.5 leading-relaxed">학교 방화벽 또는 인터넷 연결 문제로 구글 시트 전송이 지연되었습니다. 학생의 점수와 복습 화면은 정상적으로 확인 가능합니다.</p>
        </div>
      `;
    }
  }
}

// ==========================================
// 7. 선생님 연동 설정 모달 관리
// ==========================================

function openSettingsModal() {
  const modal = document.getElementById("modal-settings");
  const input = document.getElementById("gas-url-input");
  if (modal) {
    const currentUrl = localStorage.getItem(STORAGE_KEY_GAS_URL) || DEFAULT_GAS_URL;
    if (input) input.value = currentUrl;
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
}

function closeSettingsModal() {
  const modal = document.getElementById("modal-settings");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}

function saveSettings() {
  const input = document.getElementById("gas-url-input");
  if (input) {
    const val = input.value.trim();
    localStorage.setItem(STORAGE_KEY_GAS_URL, val);
    alert(val.length > 0 ? "구글 앱스 스크립트(GAS) URL이 안전하게 저장되었습니다!" : "설정이 초기화되었습니다.");
    closeSettingsModal();
  }
}

// ==========================================
// 8. 기타 유틸리티 및 초기화
// ==========================================

function toggleSound() {
  QuizState.soundEnabled = !QuizState.soundEnabled;
  localStorage.setItem(STORAGE_KEY_SOUND, QuizState.soundEnabled ? "true" : "false");
  updateSoundUI();
}

function updateSoundUI() {
  const icon = document.getElementById("sound-icon");
  if (icon) {
    if (QuizState.soundEnabled) {
      icon.className = "fa-solid fa-volume-high text-indigo-600";
    } else {
      icon.className = "fa-solid fa-volume-xmark text-slate-400";
    }
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// DOM 준비 시 초기화
document.addEventListener("DOMContentLoaded", () => {
  // 소리 설정 복원
  const savedSound = localStorage.getItem(STORAGE_KEY_SOUND);
  if (savedSound !== null) {
    QuizState.soundEnabled = (savedSound === "true");
  }
  updateSoundUI();

  // 최초 랜덤 익명 별명 발급
  updateNicknameUI();

  // 화면을 인트로 화면으로 초기화
  switchScreen("intro");
});

// 전역 노출 함수
window.startQuiz = startQuiz;
window.selectOption = selectOption;
window.handleNextQuestion = handleNextQuestion;
window.renderReviewList = renderReviewList;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.saveSettings = saveSettings;
window.toggleSound = toggleSound;
window.updateNicknameUI = updateNicknameUI;
