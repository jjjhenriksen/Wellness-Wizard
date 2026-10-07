const sendButton = document.getElementById('sendButton');
const responseArea = document.getElementById('responseArea');
let generation = 0;
let controller;
let typingTimer;

// Latest send wins, including while the preceding answer is being animated.
sendButton.addEventListener('click', async () => {
  const userInput = document.getElementById('userInput').value.trim();
  if (!userInput) {
    if (!controller && !typingTimer) responseArea.innerText = 'Please type something!';
    return;
  }
  const current = ++generation;
  controller?.abort();
  clearTimeout(typingTimer);
  typingTimer = undefined;
  responseArea.classList.remove('glow');
  const requestController = new AbortController();
  controller = requestController;
  responseArea.setAttribute('aria-busy', 'true');
  responseArea.innerText = 'The Wizard is thinking...';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userInput }), signal: requestController.signal,
    });
    const data = await res.json();
    if (current !== generation) return;
    if (!res.ok) throw new Error(data.message || 'The Wizard could not respond. Please try again.');
    if (typeof data.reply !== 'string') throw new Error('The Wizard returned an unreadable response.');
    responseArea.textContent = '';
    const reply = data.reply;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      responseArea.textContent = reply;
      responseArea.setAttribute('aria-busy', 'false');
      return;
    }
    responseArea.classList.add('glow');
    let index = 0;
    function typeLetter() {
      if (current !== generation) return;
      if (index < reply.length) {
        responseArea.textContent += reply[index++];
        typingTimer = setTimeout(typeLetter, 30);
      } else {
        typingTimer = undefined;
        responseArea.classList.remove('glow');
        responseArea.setAttribute('aria-busy', 'false');
      }
    }
    typeLetter();
  } catch (error) {
    if (current !== generation || requestController.signal.aborted) return;
    responseArea.innerText = error.message || 'The Wizard could not respond. Please try again.';
    responseArea.setAttribute('aria-busy', 'false');
  } finally {
    if (current === generation) controller = undefined;
  }
});
