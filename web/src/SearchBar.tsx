import { forwardRef } from "react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  ({ value, onChange, placeholder }, ref) => {
    return (
      <div className="search-bar">
        <span className="search-slash">/</span>
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        {value && (
          <button className="search-clear" onClick={() => onChange("")}>
            ×
          </button>
        )}
      </div>
    );
  },
);
