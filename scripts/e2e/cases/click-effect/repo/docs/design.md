# Store client design notes

## Button states

- Hover (primary): background `#31b556` (already done).
- Pressed (primary buttons only, `.btn-primary:active`): the button shrinks a little and gets darker:
  `transform: scale(0.98)` and background `#1f7a38`.
- Put the transition on `.btn-primary` itself, not on `:active`, so that releasing animates too:
  `transition: transform 80ms ease, background-color 80ms ease`.
- Secondary buttons (`.btn-secondary`) have no pressed effect yet. Do not change them.
