import { InputHTMLAttributes } from 'react';
export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
    /** If true, displays the checkbox with an indeterminate icon instead of checked or unchecked. */
    indeterminate?: boolean;
}
/**
 * Renders a checkbox input with custom styling and optional indeterminate state.
 * The component visually hides the actual input element for accessibility while providing a custom styled appearance.
 */
export declare const Checkbox: import("react").ForwardRefExoticComponent<CheckboxProps & import("react").RefAttributes<HTMLInputElement>>;
//# sourceMappingURL=Checkbox.d.ts.map