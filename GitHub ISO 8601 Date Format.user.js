// ==UserScript==
// @license MIT
// @name        GitHub ISO 8601 Date Format
// @description 将 GitHub 页面中的英文月份日期显示为 ISO 8601 数字日期，保留相对时间
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

  const INCLUDE_TIME_FOR_DATE_ONLY = false;

  const dateElementSelector = [
    'relative-time[datetime]',
    'local-time[datetime]',
    'time[datetime]'
  ].join(',');

  const textElementSelector = [
    '[data-testid="commit-group-title"]'
  ].join(',');

  const style = document.createElement('style');
  style.textContent = `
    relative-time[data-codex-date],
    local-time[data-codex-date],
    time[data-codex-date] {
      font-size: 0 !important;
    }

    relative-time[data-codex-date]::after,
    local-time[data-codex-date]::after,
    time[data-codex-date]::after {
      content: attr(data-codex-date);
      font-size: var(--codex-date-font-size, 12px);
    }
  `;
  document.head.appendChild(style);

  const monthNumbers = {
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
  };

  const monthPattern = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const monthFirstDateRegex = new RegExp(`^(${monthPattern})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?$`, 'i');
  const dayMonthTimeRegex = new RegExp(`^(\\d{1,2})\\s+(${monthPattern})\\s+(\\d{1,2}):(\\d{2})$`, 'i');
  const commitGroupDateRegex = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2}),\\s*(\\d{4})\\b`, 'gi');
  const relativeTextRegex = /\b(?:now|ago|from now|yesterday|today|tomorrow|last|minute|hour|day|week|month|year)s?\b/i;
  const defaultRelativeThresholdMilliseconds = 30 * 24 * 60 * 60 * 1000;

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function monthNumber(monthName) {
    return monthNumbers[monthName.slice(0, 3).toLowerCase()];
  }

  function formatDateParts(year, month, day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function formatDateTimeParts(year, month, day, hour, minute) {
    return `${formatDateParts(year, month, day)} ${pad2(hour)}:${pad2(minute)}`;
  }

  function formatLocalDate(date) {
    return formatDateParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  function formatLocalDateTime(date, includeSeconds = false) {
    const text = formatDateTimeParts(
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes()
    );

    return includeSeconds ? `${text}:${pad2(date.getSeconds())}` : text;
  }

  function formatUtcDateTime(date) {
    return formatDateTimeParts(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes()
    );
  }

  function getDateElementText(element, date) {
    const visibleText = element.textContent.trim().replace(/\s+/g, ' ');

    if (!element.matches('relative-time')) {
      return INCLUDE_TIME_FOR_DATE_ONLY ? formatLocalDateTime(date) : formatLocalDate(date);
    }

    const format = (element.getAttribute('format') || 'auto').toLowerCase();
    if (format === 'datetime') {
      return INCLUDE_TIME_FOR_DATE_ONLY ? formatLocalDateTime(date) : formatLocalDate(date);
    }

    if (relativeTextRegex.test(visibleText)) {
      return null;
    }

    if (format === 'duration' || format === 'micro' || format === 'elapsed') {
      return null;
    }

    const tense = (element.getAttribute('tense') || 'auto').toLowerCase();
    if (tense !== 'auto') {
      return null;
    }

    if (Math.abs(Date.now() - date.getTime()) <= defaultRelativeThresholdMilliseconds) {
      return null;
    }

    if (element.hasAttribute('prefix')) {
      return formatUtcDateTime(date);
    }

    const dayMonthTimeMatch = visibleText.match(dayMonthTimeRegex);
    if (dayMonthTimeMatch) {
      const [, day, monthName, hour, minute] = dayMonthTimeMatch;
      return formatDateTimeParts(
        date.getUTCFullYear(),
        monthNumber(monthName),
        Number(day),
        Number(hour),
        Number(minute)
      );
    }

    const monthFirstDateMatch = visibleText.match(monthFirstDateRegex);
    if (monthFirstDateMatch) {
      const [, monthName, day, year] = monthFirstDateMatch;
      return formatDateParts(
        year ? Number(year) : date.getFullYear(),
        monthNumber(monthName),
        Number(day)
      );
    }

    return null;
  }

  function formatDateElement(element) {
    const rawDateTime = element.getAttribute('datetime');
    if (!rawDateTime) {
      clearFormat(element);
      return;
    }

    const date = new Date(rawDateTime);
    if (Number.isNaN(date.getTime())) {
      clearFormat(element);
      return;
    }

    const text = getDateElementText(element, date);
    if (!text) {
      clearFormat(element);
      return;
    }

    applyFormat(element, text, formatLocalDateTime(date, true));
  }

  function applyFormat(element, text, title) {
    const existingFontSize = element.style.getPropertyValue('--codex-date-font-size');
    const fontSize = existingFontSize && existingFontSize !== '0px'
      ? existingFontSize
      : getComputedStyle(element).fontSize;

    if (!hasDatasetKey(element, 'codexOriginalTitle')) {
      element.dataset.codexOriginalTitle = element.getAttribute('title') || '';
    }

    element.style.setProperty('--codex-date-font-size', fontSize);
    element.dataset.codexDate = text;
    element.title = title;
  }

  function clearFormat(element) {
    delete element.dataset.codexDate;
    element.style.removeProperty('--codex-date-font-size');

    if (!hasDatasetKey(element, 'codexOriginalTitle')) {
      return;
    }

    if (element.dataset.codexOriginalTitle) {
      element.title = element.dataset.codexOriginalTitle;
    } else {
      element.removeAttribute('title');
    }

    delete element.dataset.codexOriginalTitle;
  }

  function hasDatasetKey(element, key) {
    return Object.prototype.hasOwnProperty.call(element.dataset, key);
  }

  function formatTextElement(element) {
    const nextText = element.textContent.replace(
      commitGroupDateRegex,
      (_, monthName, day, year) => formatDateParts(Number(year), monthNumber(monthName), Number(day))
    );

    if (nextText !== element.textContent) {
      element.textContent = nextText;
    }
  }

  function formatAll(root = document) {
    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(dateElementSelector)) {
      formatDateElement(root);
    }

    root.querySelectorAll?.(dateElementSelector).forEach(formatDateElement);

    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(textElementSelector)) {
      formatTextElement(root);
    }

    root.querySelectorAll?.(textElementSelector).forEach(formatTextElement);
  }

  function formatNearest(node) {
    const element = node.nodeType === Node.ELEMENT_NODE
      ? node
      : node.parentElement;

    const dateElement = element?.closest?.(dateElementSelector);
    if (dateElement) {
      formatDateElement(dateElement);
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
        formatNearest(mutation.target);
        mutation.addedNodes.forEach(formatAll);
      } else if (mutation.type === 'characterData') {
        formatNearest(mutation.target);
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
    attributeFilter: ['datetime', 'format', 'prefix', 'tense']
  });

  window.setTimeout(formatAll, 250);
  window.setTimeout(formatAll, 1000);
})();
