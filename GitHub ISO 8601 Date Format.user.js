// ==UserScript==
// @license MIT
// @name        GitHub ISO 8601 Date Format
// @description 将 GitHub 的英文绝对日期显示为 ISO 8601 的 yyyy-MM-dd 格式，保留相对时间
// @author      BAKAOLC
// @version     1.0.0
// @match       https://github.com/*
// @match       https://gist.github.com/*
// @namespace   none
// @grant       none
// @run-at      document-idle
// @supportURL  https://github.com/BAKAOLC/Tampermonkey-Script
// @homepageURL https://github.com/BAKAOLC/Tampermonkey-Script
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // Set to true to show time too, for example: 2026-04-07 14:30.
  const INCLUDE_TIME = false;

  const dateElementSelector = [
    'relative-time[datetime]',
    'local-time[datetime]',
    'time[datetime]'
  ].join(',');

  const obsoleteDateElementSelector = [
    'time-ago[data-codex-date]'
  ].join(',');

  const textElementSelector = [
    '[data-testid="commit-group-title"]'
  ].join(',');

  const style = document.createElement('style');
  style.textContent = `
    local-time[data-codex-date],
    relative-time[data-codex-date],
    time[data-codex-date] {
      font-size: 0 !important;
    }

    local-time[data-codex-date]::after,
    relative-time[data-codex-date]::after,
    time[data-codex-date]::after {
      content: attr(data-codex-date);
      font-size: var(--codex-date-font-size, 12px);
    }
  `;
  document.head.appendChild(style);

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatDate(date) {
    return [
      date.getFullYear(),
      pad2(date.getMonth() + 1),
      pad2(date.getDate())
    ].join('-');
  }

  function formatDateTime(date, includeSeconds = false) {
    const time = [
      pad2(date.getHours()),
      pad2(date.getMinutes()),
      includeSeconds ? pad2(date.getSeconds()) : null
    ].filter(Boolean).join(':');

    return `${formatDate(date)} ${time}`;
  }

  function formatDateElement(element) {
    const rawDateTime = element.getAttribute('datetime');
    if (!rawDateTime) {
      return;
    }

    const date = new Date(rawDateTime);
    if (Number.isNaN(date.getTime())) {
      return;
    }

    if (!shouldFormatDateElement(element, date)) {
      clearFormat(element);
      return;
    }

    const text = INCLUDE_TIME
      ? formatDateTime(date)
      : formatDate(date);

    const existingFontSize = element.style.getPropertyValue('--codex-date-font-size');
    const fontSize = existingFontSize && existingFontSize !== '0px'
      ? existingFontSize
      : getComputedStyle(element).fontSize;

    if (!Object.hasOwn(element.dataset, 'codexOriginalTitle')) {
      element.dataset.codexOriginalTitle = element.getAttribute('title') || '';
    }

    element.style.setProperty('--codex-date-font-size', fontSize);
    element.dataset.codexDate = text;
    element.title = formatDateTime(date, true);
  }

  function formatTextElement(element) {
    const nextText = element.textContent.replace(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s*(\d{4})\b/gi,
      (_, monthName, day, year) => `${year}-${pad2(monthNumber(monthName))}-${pad2(day)}`
    );

    if (nextText !== element.textContent) {
      element.textContent = nextText;
    }
  }

  function shouldFormatDateElement(element, date) {
    if (!element.matches('relative-time')) {
      return true;
    }

    return shouldFormatRelativeTime(element, date);
  }

  function shouldFormatRelativeTime(element, date) {
    const format = (element.getAttribute('format') || 'auto').toLowerCase();
    const tense = (element.getAttribute('tense') || 'auto').toLowerCase();

    if (format === 'datetime') {
      return true;
    }

    if (format === 'duration' || format === 'micro' || format === 'elapsed' || tense !== 'auto') {
      return false;
    }

    const visibleText = element.textContent.trim();
    if (isRelativeTimeText(visibleText)) {
      return false;
    }

    if (isEnglishMonthDateText(visibleText)) {
      return true;
    }

    const thresholdMilliseconds = parseThresholdMilliseconds(element.getAttribute('threshold')) ?? 30 * 24 * 60 * 60 * 1000;
    return Math.abs(Date.now() - date.getTime()) > thresholdMilliseconds;
  }

  function clearFormat(element) {
    delete element.dataset.codexDate;
    element.style.removeProperty('--codex-date-font-size');

    if (Object.hasOwn(element.dataset, 'codexOriginalTitle')) {
      if (element.dataset.codexOriginalTitle) {
        element.title = element.dataset.codexOriginalTitle;
      } else {
        element.removeAttribute('title');
      }

      delete element.dataset.codexOriginalTitle;
    }
  }

  function monthNumber(monthName) {
    const normalized = monthName.slice(0, 3).toLowerCase();
    return {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12
    }[normalized];
  }

  function isRelativeTimeText(text) {
    return /\b(?:now|ago|from now|yesterday|today|tomorrow|last|minute|hour|day|week|month|year)s?\b/i.test(text);
  }

  function isEnglishMonthDateText(text) {
    return /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/i.test(text);
  }

  function parseThresholdMilliseconds(value) {
    if (!value) {
      return null;
    }

    const match = value.match(/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
    if (!match) {
      return null;
    }

    const [, years, months, weeks, days, hours, minutes, seconds] = match;
    return [
      [years, 365 * 24 * 60 * 60 * 1000],
      [months, 30 * 24 * 60 * 60 * 1000],
      [weeks, 7 * 24 * 60 * 60 * 1000],
      [days, 24 * 60 * 60 * 1000],
      [hours, 60 * 60 * 1000],
      [minutes, 60 * 1000],
      [seconds, 1000]
    ].reduce((total, [part, scale]) => total + (Number(part || 0) * scale), 0);
  }

  function formatAll(root = document) {
    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(obsoleteDateElementSelector)) {
      clearFormat(root);
    }

    root.querySelectorAll?.(obsoleteDateElementSelector).forEach(clearFormat);

    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(dateElementSelector)) {
      formatDateElement(root);
    }

    root.querySelectorAll?.(dateElementSelector).forEach(formatDateElement);

    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(textElementSelector)) {
      formatTextElement(root);
    }

    root.querySelectorAll?.(textElementSelector).forEach(formatTextElement);
  }

  function formatNearestElement(node) {
    const element = node.nodeType === Node.ELEMENT_NODE
      ? node
      : node.parentElement;

    const obsoleteTimeElement = element?.closest?.(obsoleteDateElementSelector);
    if (obsoleteTimeElement) {
      clearFormat(obsoleteTimeElement);
      return;
    }

    const timeElement = element?.closest?.(dateElementSelector);
    if (timeElement) {
      formatDateElement(timeElement);
      return;
    }

    const textElement = element?.closest?.(textElementSelector);
    if (textElement) {
      formatTextElement(textElement);
    }
  }

  formatAll();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        formatNearestElement(mutation.target);
        mutation.addedNodes.forEach(formatAll);
      } else if (mutation.type === 'characterData') {
        formatNearestElement(mutation.target);
      } else if (mutation.type === 'attributes') {
        formatDateElement(mutation.target);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['datetime', 'format', 'tense', 'threshold']
  });

  window.setTimeout(formatAll, 250);
  window.setTimeout(formatAll, 1000);
})();
