class_name UIPalette
extends RefCounted

## Centralized color palette for the entire game UI.
## Neon Stadium aesthetic: deep cosmic indigo + electric cyan + hot magenta + neon gold.

# Background tones
const BG_DEEP        := Color(0.045, 0.06, 0.12, 1.0)
const BG_PANEL       := Color(0.115, 0.13, 0.245, 1.0)
const BG_PANEL_LIGHT := Color(0.165, 0.195, 0.34, 1.0)
const BG_INPUT       := Color(0.05, 0.07, 0.13, 1.0)
const BG_BUTTON      := Color(0.16, 0.22, 0.4, 1.0)
const BG_BUTTON_HOVER  := Color(0.24, 0.34, 0.62, 1.0)
const BG_BUTTON_PRESSED := Color(0.10, 0.14, 0.27, 1.0)
const BG_BUTTON_DISABLED := Color(0.085, 0.10, 0.18, 1.0)
const BG_DESTRUCTIVE := Color(0.42, 0.13, 0.20, 1.0)
const BG_DESTRUCTIVE_HOVER := Color(0.62, 0.18, 0.27, 1.0)

# Accent colors
const ACCENT_GOLD    := Color(1.000, 0.840, 0.200, 1.0)
const ACCENT_CYAN    := Color(0.300, 0.920, 1.000, 1.0)
const ACCENT_MAGENTA := Color(0.960, 0.300, 0.780, 1.0)
const ACCENT_RED     := Color(1.000, 0.300, 0.360, 1.0)
const ACCENT_LIME    := Color(0.400, 0.960, 0.450, 1.0)

# Text
const TEXT_PRIMARY   := Color(0.960, 0.980, 1.000, 1.0)
const TEXT_SECONDARY := Color(0.700, 0.780, 0.920, 1.0)
const TEXT_DIM       := Color(0.480, 0.560, 0.720, 1.0)

# Status colors
const STATUS_OK      := Color(0.400, 1.000, 0.500, 1.0)
const STATUS_ERROR   := Color(1.000, 0.420, 0.520, 1.0)
const STATUS_PENDING := Color(0.760, 0.780, 0.860, 1.0)

# Borders
const BORDER_NORMAL  := Color(0.300, 0.860, 1.000, 0.550)
const BORDER_HOVER   := Color(0.300, 0.920, 1.000, 1.000)
const BORDER_FOCUS   := Color(1.000, 0.840, 0.200, 1.000)
const BORDER_DESTRUCTIVE := Color(1.000, 0.300, 0.360, 0.900)

# Common dimensions
const RADIUS_CARD    := 18
const RADIUS_BUTTON  := 10
const RADIUS_INPUT   := 10
const PADDING_CARD   := 36
const PADDING_BUTTON_H := 28
const PADDING_BUTTON_V := 18
