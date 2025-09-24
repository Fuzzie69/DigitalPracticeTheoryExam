// This file replaces the original script.js and acts as the entry point.
// The logic has been refactored into quiz.js and ui.js modules.
import * as quiz from './quiz.js';
import * as ui from './ui.js';

document.addEventListener('DOMContentLoaded', () => {
    // Initial setup
    quiz.init();

    // Event Listeners
    ui.startBtn.addEventListener('click', quiz.startExam);
    ui.nextBtn.addEventListener('click', quiz.nextQuestion);
    ui.prevBtn.addEventListener('click', quiz.prevQuestion);
    ui.flagBtn.addEventListener('click', quiz.toggleFlag);
    ui.submitBtn.addEventListener('click', () => {
        // Always allow submit attempt, quiz.js will handle question count logic
        quiz.handleSubmitAttempt();
    });

    // Use confirmation for restart
    ui.setupRestartConfirmation(() => {
        if (typeof quiz !== 'undefined' && quiz && quiz.restartExam) {
            quiz.restartExam();
        } else {
            console.error("quiz.restartExam is not a function");
        }
    });

    // Modal listeners
    ui.closeModalBtn.addEventListener('click', () => ui.hideFlagModal());
    ui.submitAnywayBtn.addEventListener('click', () => {
        ui.hideFlagModal();
        quiz.submitExam();
    });
    window.addEventListener('click', (event) => {
        if (event.target == ui.flagModal) {
            ui.hideFlagModal();
        }
    });

    ui.progressBar.addEventListener('click', (event) => {
        if (event.target.classList.contains('progress-box')) {
            const index = parseInt(event.target.dataset.index, 10);
            if (!isNaN(index)) {
                quiz.goToQuestion(index);
            }
        }
    });
});