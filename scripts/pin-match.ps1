# Pin comparison for check-updates.ps1, kept in a dot-sourceable file so it can
# be tested without running the whole check (which talks to a registry).
#
# Why this is a function and not an inline condition: until 2.0.10 the comparison
# was "equal, OR shares the first dotted component with the pin", applied to every
# component. "6.5.0".StartsWith("6.") is true, so a bundle still on 6.5.0 reported
# "consistent with pin 6.7.0", and that line is the only signal a user has that a
# pin bump requires re-running setup. apktool had the same shape (3.0.9 vs 3.0.3,
# where the major-prefix test called them equal).
#
# The one pin that is genuinely major-only is the JDK ("21"): the download records
# 21.0.12.1+1 and both name the same family. A dotted pin names exactly one
# version. The reverse rule, prefix matching on a dotted pin, is the bug.
# Kept ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less script as
# ANSI, and this file ships inside the package.
function Test-PinMatch {
  param(
    [string]$Installed,
    [string]$Pinned
  )
  $installed = ([string]$Installed).Trim()
  $pinned = ([string]$Pinned).Trim()
  if ($installed -eq '' -or $pinned -eq '') { return $false }
  $same = [string]::Equals($installed, $pinned, [System.StringComparison]::Ordinal)
  if ($pinned.Contains('.')) { return $same }
  # A major-only pin ("21") also matches its point releases ("21.0.12.1+1").
  return ($same -or $installed.StartsWith($pinned + '.', [System.StringComparison]::Ordinal))
}
