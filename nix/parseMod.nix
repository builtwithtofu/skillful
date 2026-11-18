{ lib, facts }:

path:

let
  filename = toString path;
  text = builtins.readFile path;
  fail = line: message: throw "${filename}:${toString line}: ${message}";
  whitespace = character: builtins.elem character [ " " "\t" "\n" "\r" ];
  tokenize = compact: line: raw:
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
      punctuation = character: builtins.elem character [ "{" "}" "=" ];
      token = quoted: value: if compact then { inherit quoted value; } else value;
      bareEnd = index:
        if index < length && !whitespace (characterAt index)
          && (!compact || (!punctuation (characterAt index) && characterAt index != "\""))
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
          else go (end + 1) (tokens ++ [ (token true decoded.value) ])
        else
          let
            end = if compact && punctuation (characterAt start) then start + 1 else bareEnd start;
            value = builtins.substring start (end - start) raw;
            valid = compact || value == "(" || value == ")" || (builtins.match ''[^[:space:]()"]+'' value != null && !lib.hasInfix "//" value);
          in if !valid
          then fail line "invalid bare token ${builtins.toJSON value}"
          else go end (tokens ++ [ (token false value) ]);
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
      tokens = tokenize false line entry.value;
      count = builtins.length tokens;
      first = if count == 0 then null else builtins.elemAt tokens 0;
    in if count == 0
    then state
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
  bare = token: word: !token.quoted && token.value == word;
  pathToken = token: token.value != "" && (token.quoted || !(builtins.elem token.value [ "{" "}" "=" ]));
  readHarness = line: entry: tokens:
    if tokens == [ ] then entry else
    let
      key = builtins.head tokens;
      rest = builtins.tail tokens;
      operand = builtins.head rest;
    in if bare key "}" && rest == [ ] then entry // { closed = true; }
    else if bare key "reads-shared" && !entry.readsShared then readHarness line (entry // { readsShared = true; }) rest
    else if key.quoted || !(builtins.elem key.value [ "skills" "commands" "rules" ]) || rest == [ ] || !pathToken operand || builtins.hasAttr key.value entry.paths
    then fail line "invalid harness field"
    else readHarness line (entry // { paths = entry.paths // { ${key.value} = normalizePath line operand.value; }; }) (builtins.tail rest);
  stepV2 = state: entry:
    let
      line = entry.index + 1;
      tokens = tokenize true line entry.value;
      directive = builtins.head tokens;
      args = builtins.tail tokens;
      values = map (token: token.value) args;
      machine = if state.machine == null then null else state.setups.${state.machine};
      updateMachine = changes: state // { setups = state.setups // { ${state.machine} = machine // changes; }; };
      storeHarness = harness:
        if !harness.closed then state // { inner = harness; } else
        let
          declarations = if machine == null then state.declarations else machine.declarations;
          updated = declarations // { ${harness.name} = harness; };
        in (if machine == null then state // { declarations = updated; } else updateMachine { declarations = updated; }) // { inner = null; };
      addSkips = selection: skills: {
        mode = if skills == [ ] then selection.mode else "omit";
        skills = selection.skills ++ map (token: { name = token.value; }) skills;
      };
    in if tokens == [ ] then state
    else if state.inner != null then storeHarness (readHarness line state.inner tokens)
    else if bare directive "harness" then
      let
        name = requireName line "harness" (if args == [ ] then "" else builtins.head values);
        declarations = if machine == null then state.declarations else machine.declarations;
      in if builtins.length args < 2 || !bare (builtins.elemAt args 1) "{" || (builtins.head args).quoted || name == "opencode-v2"
      then fail line "expected harness <agent> {"
      else if builtins.hasAttr name declarations then fail line "duplicate harness ${name}"
      else storeHarness (readHarness line { inherit name; paths = { }; readsShared = false; closed = false; } (lib.drop 2 args))
    else if machine != null then
      if bare directive "}" && args == [ ] && machine.declarations != { } then state // { machine = null; }
      else if bare directive "skip" && args != [ ] && builtins.all pathToken args then updateMachine { selection = addSkips machine.selection args; }
      else fail line "invalid machine block entry"
    else if bare directive "rules" then state // { explicitRules = true; }
    else if bare directive "agents" then
      if state.agents != null then fail line "agents may appear at most once"
      else if values == [ ] then fail line "agents must list at least one agent"
      else state // { agents = lib.unique values; }
    else if bare directive "machine" then
      let
        name = requireName line "machine" (if args == [ ] then "" else builtins.head values);
        second = builtins.elemAt args 1;
        block = builtins.length args == 2 && bare second "{";
        skills = lib.drop 2 args;
      in if builtins.hasAttr name state.setups then fail line "duplicate machine ${name}"
      else if !block && builtins.length args > 1 && (!bare second "skip" || skills == [ ] || !builtins.all pathToken skills)
      then fail line "machine must be: machine <name> [skip <skills>] or machine <name> {"
      else state // {
        machine = if block then name else null;
        setups = state.setups // {
          ${name} = { inherit name; root = "home"; declarations = { }; selection = addSkips { mode = "all"; skills = [ ]; } skills; };
        };
      }
    else state;
  entries = lib.imap0 (index: value: { inherit index value; }) (lib.splitString "\n" text);
  header = lib.findFirst (entry: tokenize false (entry.index + 1) entry.value != [ ]) { index = 0; value = ""; } entries;
  headerTokens = tokenize false (header.index + 1) header.value;
  version =
    if lib.hasInfix "\r" text then fail 1 "skill.mod must use LF line endings"
    else if headerTokens == [ "skillful" "1" ] then 1
    else if headerTokens == [ "skillful" "2" ] then 2
    else fail (header.index + 1) "first semantic directive must be: skillful 1 or skillful 2";
  body = lib.drop (header.index + 1) entries;
  parsedV1 = lib.foldl' step { setups = { }; current = null; inner = null; } body;
  v2 = lib.foldl' stepV2 { setups = { }; agents = null; declarations = { }; machine = null; inner = null; explicitRules = false; } body;
  parsedV2 = if v2.inner != null || v2.machine != null then fail (builtins.length entries) "unclosed machine or harness block" else v2;
  resolveAgent = declarations: name:
    let
      builtin = facts.${name} or null;
      global = parsedV2.declarations.${name} or null;
      local = declarations.${name} or null;
    in if builtin == null && global == null && local == null then throw "unknown agent ${builtins.toJSON name}"
    else {
      inherit name;
      paths = (if builtin == null then { } else builtin.installPaths.home)
        // lib.optionalAttrs (name == "codex") { skills = ".codex/skills"; }
        // lib.optionalAttrs (name == "claude") { rules = ".claude/CLAUDE.md"; }
        // (global.paths or { }) // (local.paths or { });
      readsShared = (builtin != null && name != "claude") || (global.readsShared or false) || (local.readsShared or false);
    };
in
{
  inherit version;
  explicitRules = version == 2 && parsedV2.explicitRules;
  homeHarnessPaths = if version == 2 then lib.genAttrs knownHarnesses (name: (resolveAgent { } name).paths) else { };
  setups = if version == 2 then builtins.mapAttrs (name: setup: setup // {
    harnesses = if parsedV2.agents == null then throw "skillful machine ${name} selects no agents" else map (resolveAgent setup.declarations) parsedV2.agents;
  }) parsedV2.setups
  else if parsedV1.inner != null then fail parsedV1.current.line "unclosed setup harness block"
  else if parsedV1.current != null then fail parsedV1.current.line "unclosed setup block"
  else parsedV1.setups;
}
