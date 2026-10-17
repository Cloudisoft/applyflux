import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Select from 'react-select';

// Mounts the real react-select into every <div class="rs-real" data-*>, configured like Greenhouse's job boards.
function Field({ id, name, options }) {
  const [value, setValue] = useState(null);
  return React.createElement(Select, {
    inputId: id,
    instanceId: id,
    name,
    classNamePrefix: 'select',
    options: options.map((o) => ({ value: o, label: o })),
    value,
    onChange: setValue,
    'aria-required': true,
    placeholder: 'Select...',
    menuPlacement: 'auto',
  });
}
document.querySelectorAll('.rs-real').forEach((el) => {
  createRoot(el).render(React.createElement(Field, { id: el.dataset.id, name: el.dataset.name, options: JSON.parse(el.dataset.options) }));
});
