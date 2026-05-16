import { translations } from "./translations.js";

const supportedLanguages = Object.keys(translations);

export function createI18n(initialLanguage = "en") {
  let language = supportedLanguages.includes(initialLanguage) ? initialLanguage : "en";

  function t(key, params = {}) {
    const value = key.split(".").reduce((branch, part) => branch?.[part], translations[language]);
    const fallback = key.split(".").reduce((branch, part) => branch?.[part], translations.en);
    return String(value ?? fallback ?? key).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? "");
  }

  function apply(root = document) {
    root.documentElement.lang = language;
    root.querySelectorAll("[data-i18n]").forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    });
    root.querySelectorAll("[data-i18n-title]").forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
    });
    root.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
      node.ariaLabel = t(node.dataset.i18nAriaLabel);
    });
    root.querySelectorAll("[data-i18n-label]").forEach((node) => {
      node.label = t(node.dataset.i18nLabel);
    });
  }

  return {
    get language() {
      return language;
    },
    setLanguage(nextLanguage) {
      language = supportedLanguages.includes(nextLanguage) ? nextLanguage : "en";
      localStorage.setItem("routePlannerLanguage", language);
      apply();
    },
    t,
    apply,
    supportedLanguages,
  };
}
