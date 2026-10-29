# GitHub research receipt

## Last sync

- receipt_recorded_at: 2026-10-29T06:48:51.531Z
- repo: Forichok/Agent-Notch
- branch: HEAD resolved through the GitHub commits endpoint
- commit: 70dd0cb81f0406affb817a916ee5e58a3b40a9e4
- repo: Aforno/AgentNotch
- branch: HEAD resolved through the GitHub commits endpoint
- commit: 3606bf0dd2ada56e7bf0cfef9bd9ce5b194d3811
- REA reference: https://github.com/morluto/rea

## Surface-to-source map

| SS area | Reference | Result |
|---|---|---|
| Notification → record | Aforno/AgentNotch `Services/AgentNotificationService.swift` | Store a record identifier in notification metadata and resolve it on the click callback |
| Notch geometry / floating panel | Forichok/Agent-Notch `NotchController.swift` | Use public screen safe-area geometry and an AppKit panel; provide an ordinary-display fallback |
| Expansion / collapse / reduced motion | Aforno/AgentNotch `UI/Notch/NotchRootView.swift` | Separate presentation state, delayed hover changes and short native transitions |
| SS App / service boundaries | Local `native/app/main.swift`, `native/macos/main.swift`, `internal/notify` | Keep local login, the shared hub service and approval execution separate from navigation |

References were read as source material. No third-party source files or assets were copied into SS. The Swift component and SS link protocol were implemented for this repository using system frameworks.
