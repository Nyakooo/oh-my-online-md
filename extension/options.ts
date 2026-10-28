document.querySelector<HTMLButtonElement>('#open-settings')!.onclick = async () => {
  const response = await chrome.runtime.sendMessage({ type: 'open-notes', configure: true });
  if (response?.error) document.querySelector('#options-error')!.textContent = response.error;
};
export {};
