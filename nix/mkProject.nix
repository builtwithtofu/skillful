{ self }:
{
  pkgs,
  src,
  projectDir ? ".",
  dependencyOverrides ? { },
  extraRoots ? { },
}:

let
  lib = pkgs.lib;
  engineCli = self.packages.${pkgs.stdenv.hostPlatform.system}.skillful;
  storePath = name: value:
    if builtins.typeOf value == "path"
    then builtins.path { path = value; name = "skillful-${name}"; }
    else value;
  projectSource = storePath "project" src;
  projectRoot = projectSource + "/${projectDir}";
  harnessDir = ../harnesses;
  harnessFiles = builtins.attrNames (lib.filterAttrs (name: type: type == "regular" && lib.hasSuffix ".json" name) (builtins.readDir harnessDir));
  facts = builtins.listToAttrs (map (file:
    let value = builtins.fromJSON (builtins.readFile (harnessDir + "/${file}"));
    in {
      name = value.name;
      inherit value;
    }) harnessFiles);
  harnesses = builtins.attrNames facts;
  checkedExtraRoots = {
    skills = map (entry:
      if !(entry ? origin) || entry.origin == "" || !(entry ? src)
      then throw "skillful extra skill roots require non-empty origin and src"
      else entry) (extraRoots.skills or [ ]);
    commands = map (entry:
      if !(entry ? origin) || entry.origin == "" || !(entry ? src)
      then throw "skillful extra command roots require non-empty origin and src"
      else entry) (extraRoots.commands or [ ]);
  };
  lockPath = projectRoot + "/skill.lock";
  lockEntries =
    if !(builtins.pathExists lockPath)
    then [ ]
    else
      let
        text = builtins.readFile lockPath;
        rawLines = lib.splitString "\n" text;
        lines = if rawLines != [ ] && lib.last rawLines == "" then lib.init rawLines else rawLines;
        parse = index: line:
          let fields = lib.splitString " " line;
          in if line == "" || builtins.length fields != 4
          then throw "skill.lock:${toString (index + 1)} must contain exactly name ref rev narHash"
          else {
            name = builtins.elemAt fields 0;
            ref = builtins.elemAt fields 1;
            rev = builtins.elemAt fields 2;
            narHash = builtins.elemAt fields 3;
          };
        entries = lib.imap0 parse lines;
        names = map (entry: entry.name) entries;
      in
      if lib.hasInfix "<<<<<<<" text || lib.hasInfix "=======" text || lib.hasInfix ">>>>>>>" text
      then throw "skill.lock contains a merge conflict; resolve it before evaluation"
      else if names != lib.sort builtins.lessThan names || builtins.length names != builtins.length (lib.unique names)
      then throw "skill.lock dependency names must be unique and sorted"
      else if builtins.any (entry: builtins.match "[a-z0-9][a-z0-9._-]*" entry.name == null
        || builtins.match "[0-9a-f]{40,64}" entry.rev == null
        || builtins.match "sha256-[A-Za-z0-9+/]{43}=" entry.narHash == null) entries
      then throw "skill.lock contains an invalid name, revision, or SRI sha256"
      else entries;
  fetchLocked = entry:
    let
      github = builtins.match "github:([^/]+)/([^/@]+)(/([^@]+))?@(.+)" entry.ref;
      generic = builtins.match "git:(.*)@([^@#]+)(#(.*))?" entry.ref;
      fetched =
        if github != null
        then builtins.fetchTree {
          type = "github";
          owner = builtins.elemAt github 0;
          repo = builtins.elemAt github 1;
          inherit (entry) rev narHash;
        }
        else if generic != null
        then builtins.fetchTree {
          type = "git";
          url = builtins.elemAt generic 0;
          inherit (entry) rev narHash;
        }
        else throw "unsupported locked dependency ref ${entry.ref}";
      subdir = if github != null then builtins.elemAt github 3 else if generic != null then builtins.elemAt generic 3 else null;
      root = fetched.outPath;
    in if subdir == null || subdir == "" then root else root + "/${subdir}";
  lockedOverrides = builtins.listToAttrs (map (entry: {
    inherit (entry) name;
    value = if builtins.hasAttr entry.name dependencyOverrides then dependencyOverrides.${entry.name} else fetchLocked entry;
  }) lockEntries);
  resolvedOverrides = builtins.mapAttrs (name: path: storePath "dependency-${name}" path) (lockedOverrides // dependencyOverrides);
  overrideArgs = lib.concatLists (lib.mapAttrsToList (name: path: [ "--override" "${name}=${toString path}" ]) resolvedOverrides);
  normalizedExtraRoots = {
    skills = map (entry: entry // { src = storePath "extra-skill-${entry.origin}" entry.src; }) checkedExtraRoots.skills;
    commands = map (entry: entry // { src = storePath "extra-command-${entry.origin}" entry.src; }) checkedExtraRoots.commands;
  };
  extraArgs = lib.concatMap (entry: [ "--extra-skill-root" "${entry.origin}=${toString entry.src}" ]) normalizedExtraRoots.skills
    ++ lib.concatMap (entry: [ "--extra-command-root" "${entry.origin}=${toString entry.src}" ]) normalizedExtraRoots.commands;
  projectArgs = [ "--project" (toString projectRoot) "--source-root" (toString projectSource) ] ++ overrideArgs ++ extraArgs;
  escapedProjectArgs = lib.escapeShellArgs projectArgs;
  rendered = pkgs.runCommandLocal "skillful-project-render" {
    nativeBuildInputs = [ engineCli ];
    inherit projectSource projectRoot;
    dependencySources = builtins.attrValues resolvedOverrides;
    extraRootSources = map (entry: entry.src) (normalizedExtraRoots.skills ++ normalizedExtraRoots.commands);
  } ''
    export HOME="$TMPDIR/home"
    export XDG_CACHE_HOME="$TMPDIR/cache"
    export XDG_STATE_HOME="$TMPDIR/state"
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
    skillful render --project "$projectRoot" --source-root "$projectSource" --out "$TMPDIR/rendered" ${lib.escapeShellArgs (overrideArgs ++ extraArgs)}
    cp -r "$TMPDIR/rendered" "$out"
  '';
  splitDirectory = harness: category:
    pkgs.runCommandLocal "skillful-${category}-${harness}" { } ''
      cp -r ${rendered}/${harness}/${category} "$out"
    '';
  splitRules = harness:
    pkgs.runCommandLocal "skillful-rules-${harness}.md" { } ''
      cp ${rendered}/${harness}/rules.md "$out"
    '';
  forHarness = name:
    if !(builtins.hasAttr name facts)
    then throw "unknown skillful harness ${name}; known: ${lib.concatStringsSep ", " harnesses}"
    else {
      installPaths = facts.${name}.installPaths;
      skills = splitDirectory name "skills";
      commands = splitDirectory name "commands";
      rules = splitRules name;
    };
  cli = pkgs.writeShellApplication {
    name = "skillful";
    runtimeInputs = [ engineCli ];
    text = ''
      case "''${1-}" in
        list|inspect|check|diff|manifest|schema|render|install) exec ${engineCli}/bin/skillful "$@" ${escapedProjectArgs} ;;
        *) exec ${engineCli}/bin/skillful "$@" ;;
      esac
    '';
  };
  contract = pkgs.runCommandLocal "skillful-project-contract" { } ''
    mkdir -p "$out"
    cp ${rendered}/pi/.skillful/contract.json "$out/contract.json"
  '';
  checks = {
    render = rendered;
    strict = pkgs.runCommandLocal "skillful-project-strict-check" { nativeBuildInputs = [ cli ]; } ''
      skillful check --strict --format json > "$out"
    '';
  };
in
{
  inherit harnesses forHarness cli contract checks;
  installPaths = builtins.mapAttrs (_: value: value.installPaths) facts;
}
