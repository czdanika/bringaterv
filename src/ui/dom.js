export function createToast(element) {
  let timeoutId;
  return function showToast(message, duration = 3200) {
    clearTimeout(timeoutId);
    element.textContent = message;
    element.classList.add("is-visible");
    timeoutId = setTimeout(() => element.classList.remove("is-visible"), duration);
  };
}

export function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}
