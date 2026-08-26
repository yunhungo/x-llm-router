import { useId, type InputHTMLAttributes } from 'react';

import { Input } from '../input';

export function ComboboxInput({
  options,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { options: readonly string[] }) {
  const listId = useId();

  return (
    <>
      <Input {...props} list={listId} autoComplete={props.autoComplete ?? 'off'} />
      <datalist id={listId}>
        {options.map((option) => (
          <option value={option} key={option} />
        ))}
      </datalist>
    </>
  );
}
