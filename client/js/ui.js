/**
 * client/js/ui.js
 *
 * Small, framework-free DOM helpers shared by every page (spec section
 * 102 — loading/success/error states; section 116 — "UI components:
 * reusable". Deliberately minimal for the foundation phase: an alert
 * box, a button loading-state toggle, and field-level form errors. More
 * component helpers (tables, modals, etc.) are added as the pages that
 * actually need them are built, not speculatively now.
 */

/**
 * Shows a dismissable alert inside `container` (replaces any previous
 * alert in that container). `type` is 'error' | 'success' | 'info' and
 * maps to css/components.css's .alert--error / .alert--success /
 * .alert--info, which never rely on color alone (see also the icon/
 * text label in the markup below).
 */
export function showAlert(container, message, type = 'error') {
  container.innerHTML = '';
  if (!message) return;

  const alert = document.createElement('div');
  alert.className = `alert alert--${type}`;
  alert.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const label = document.createElement('strong');
  label.className = 'alert__label';
  label.textContent = type === 'error' ? 'Error: ' : type === 'success' ? 'Success: ' : 'Note: ';

  const text = document.createElement('span');
  text.textContent = message;

  alert.append(label, text);
  container.appendChild(alert);
}

export function clearAlert(container) {
  container.innerHTML = '';
}

/**
 * Puts a submit button into/out of its loading state: disables it
 * (preventing double-submits — a real requirement, not cosmetic),
 * swaps its visible label, and restores the original label exactly on
 * release so callers never need to remember it themselves.
 */
export function setButtonLoading(button, isLoading, loadingLabel = 'Please wait…') {
  if (isLoading) {
    if (button.dataset.originalLabel === undefined) {
      button.dataset.originalLabel = button.textContent;
    }
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = loadingLabel;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.originalLabel !== undefined) {
      button.textContent = button.dataset.originalLabel;
    }
  }
}

/**
 * Renders a single field-level error message right under `inputEl`
 * (creating the element on first use), and marks the input itself as
 * invalid for assistive tech via aria-invalid + aria-describedby — not
 * just a visual red border, which would fail "no reliance on color
 * alone" (spec section 99/community accessibility norms).
 */
export function setFieldError(inputEl, message) {
  const id = inputEl.id ? `${inputEl.id}-error` : null;
  let errorEl = id ? document.getElementById(id) : null;

  if (!message) {
    if (errorEl) errorEl.textContent = '';
    inputEl.removeAttribute('aria-invalid');
    return;
  }

  if (!errorEl && id) {
    errorEl = document.createElement('p');
    errorEl.id = id;
    errorEl.className = 'field-error';
    inputEl.insertAdjacentElement('afterend', errorEl);
    inputEl.setAttribute('aria-describedby', id);
  }
  if (errorEl) errorEl.textContent = message;
  inputEl.setAttribute('aria-invalid', 'true');
}
