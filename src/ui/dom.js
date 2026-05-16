export function createToast(element) {
  let timeoutId;
  return function showToast(message) {
    clearTimeout(timeoutId);
    element.textContent = message;
    element.classList.add("is-visible");
    timeoutId = setTimeout(() => element.classList.remove("is-visible"), 3200);
  };
}

export function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}
