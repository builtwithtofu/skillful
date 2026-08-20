{ lib, facts }:

path:

let
  filename = toString path;
  text = builtins.readFile path;
  fail = line: message: throw "${filename}:${toString line}: ${message}";
  whitespace = character: builtins.elem character [ " " "\t" "\n" "\r" ];
  tokenize = line: raw:
    let
      length = builtins.stringLength raw;
      characterAt = index: builtins.substring index 1 raw;
      skipWhitespace = index:
        if index < length && whitespace (characterAt index)
        then skipWhitespace (index + 1)
        else index;
      quotedEnd = index: escaped:
        if index >= length
        then fail line "unterminated JSON string"
        else
          let character = characterAt index;
          in if !escaped && character == "\""
          then index
          else quotedEnd (index + 1) (if escaped then false else character == "\\");
      bareEnd = index:
        if index < length && !whitespace (characterAt index)
        then bareEnd (index + 1)
        else index;
      go = index: tokens:
        let start = skipWhitespace index;
        in if start >= length
        then tokens
        else if tokens == [ ] && builtins.substring start 2 raw == "//"
        then [ ]
        else if characterAt start == "\""
        then
          let
            end = quotedEnd (start + 1) false;
            literal = builtins.substring start (end - start + 1) raw;
            decoded = builtins.tryEval (builtins.fromJSON literal);
          in if !decoded.success
          then fail line "invalid JSON string"
          else go (end + 1) (tokens ++ [ decoded.value ])
        else
          let
            end = bareEnd start;
            value = builtins.substring start (end - start) raw;
            valid = value == "(" || value == ")" || (builtins.match ''[^[:space:]()"]+'' value != null && !lib.hasInfix "//" value);
          in if !valid
          then fail line "invalid bare token ${builtins.toJSON value}"
          else go end (tokens ++ [ value ]);
    in go 0 [ ];
  normalizePath = line: value:
    let
      portable = builtins.replaceStrings [ "\\" ] [ "/" ] value;
      segments = lib.splitString "/" portable;
      normalized = lib.concatStringsSep "/" (builtins.filter (segment: segment != "" && segment != ".") segments);
    in if portable == "" || lib.hasPrefix "/" portable || builtins.match ''[A-Za-z]:/.*'' portable != null || builtins.elem ".." segments
    then fail line "unsafe setup path ${builtins.toJSON value}"
    else if normalized == "" then "." else normalized;
  validName = value: builtins.match ''[a-z0-9][a-z0-9._-]*'' value != null;
  requireName = line: kind: value:
    if validName value then value else fail line "invalid ${kind} name ${builtins.toJSON value}";
  knownHarnesses = builtins.attrNames facts;
  addHarness = line: state: name:
    let
      checked = requireName line "harness" name;
      names = map (harness: harness.name) state.current.harnesses;
    in if !(builtins.hasAttr checked facts)
    then fail line "unknown setup harness ${checked}; known: ${lib.concatStringsSep ", " knownHarnesses}"
    else if builtins.elem checked names
    then fail line "duplicate setup harness ${checked}"
    else state // { current = state.current // { harnesses = state.current.harnesses ++ [ { name = checked; paths = { }; } ]; }; };
  finishSetup = line: state:
    if state.current.harnesses == [ ]
    then fail line "setup ${state.current.name} must contain at least one harness"
    else state // {
      setups = state.setups // { ${state.current.name} = builtins.removeAttrs state.current [ "line" "rootSeen" ]; };
      current = null;
    };
  addSelector = line: state: kind: name: reason:
    let
      checked = name;
      mode = if kind == "only-skill" then "only" else "omit";
      names = map (selector: selector.name) state.current.selection.skills;
    in if state.current.selection.mode != "all" && state.current.selection.mode != mode
    then fail line "setup cannot mix only-skill and omit-skill"
    else if builtins.elem checked names
    then fail line "duplicate setup skill selector ${checked}"
    else state // { current = state.current // {
      selection = {
        inherit mode;
        skills = state.current.selection.skills ++ [ ({ name = checked; } // lib.optionalAttrs (reason != null && reason != "") { inherit reason; }) ];
      };
    }; };
  step = state: entry:
    let
      line = entry.index + 1;
      tokens = tokenize line entry.value;
      count = builtins.length tokens;
      first = if count == 0 then null else builtins.elemAt tokens 0;
    in if count == 0
    then state
    else if !state.header
    then if tokens == [ "skillful" "1" ]
    then state // { header = true; }
    else fail line "first semantic directive must be: skillful 1"
    else if state.current == null
    then
      if first != "setup"
      then state
      else if count != 3 || builtins.elemAt tokens 2 != "("
      then fail line "setup must be: setup <name> ("
      else
        let name = requireName line "setup" (builtins.elemAt tokens 1);
        in if builtins.hasAttr name state.setups
        then fail line "duplicate setup ${name}"
        else state // {
          current = {
            inherit name line;
            root = "home";
            rootSeen = false;
            selection = { mode = "all"; skills = [ ]; };
            harnesses = [ ];
          };
        }
    else if state.inner != null
    then if tokens == [ ")" ]
      then state // {
        current = state.current // { harnesses = lib.init state.current.harnesses ++ [ state.inner ]; };
        inner = null;
      }
      else if count != 2 || !(builtins.elem first [ "skills" "commands" "rules" ])
      then fail line "setup harness entries must be skills, commands, or rules paths"
      else if builtins.hasAttr first state.inner.paths
      then fail line "duplicate setup ${state.inner.name} path ${first}"
      else state // { inner = state.inner // { paths = state.inner.paths // { ${first} = normalizePath line (builtins.elemAt tokens 1); }; }; }
    else if tokens == [ ")" ]
    then finishSetup line state
    else if first == "root"
    then
      if count != 2 || builtins.elemAt tokens 1 != "project"
      then fail line "setup root accepts only project; omit root to use home"
      else if state.current.rootSeen
      then fail line "duplicate setup root"
      else state // { current = state.current // { root = builtins.elemAt tokens 1; rootSeen = true; }; }
    else if first == "only-skill"
    then if count != 2 then fail line "only-skill requires exactly one skill name" else addSelector line state first (builtins.elemAt tokens 1) null
    else if first == "omit-skill"
    then if count != 3 then fail line "omit-skill requires a skill name and reason" else addSelector line state first (builtins.elemAt tokens 1) (builtins.elemAt tokens 2)
    else if count == 2 && builtins.elemAt tokens 1 == "("
    then
      let added = addHarness line state first;
      in added // { inner = builtins.elemAt added.current.harnesses (builtins.length added.current.harnesses - 1); }
    else
      let
        added = lib.foldl' (innerState: name: addHarness line innerState name) state tokens;
      in added;
  entries = lib.imap0 (index: value: { inherit index value; }) (lib.splitString "\n" text);
  parsed = lib.foldl' step { setups = { }; current = null; inner = null; header = false; } entries;
  finalized =
    if lib.hasInfix "\r" text
    then fail 1 "skill.mod must use LF line endings"
    else if !parsed.header
    then fail 1 "first semantic directive must be: skillful 1"
    else if parsed.inner != null
    then fail parsed.current.line "unclosed setup harness block"
    else if parsed.current != null
    then fail parsed.current.line "unclosed setup block"
    else parsed.setups;
in
finalized
