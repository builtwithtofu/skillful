{ self }:
{
  pkgs,
  src,
  projectDir ? ".",
  dependencyOverrides ? { },
  extraRoots ? { },
}:

let
  sourceContext = builtins.attrValues (builtins.getContext (toString src));
  hasDerivationContext = pkgs.lib.any (entry: entry ? outputs || entry ? allOutputs) sourceContext;
in
if pkgs.lib.isDerivation src || hasDerivationContext
then throw "skillful mkProject src must be a source path or flake input, not a derivation"
else
let
  lib = pkgs.lib;
  engineCli = self.packages.${pkgs.stdenv.hostPlatform.system}.skillful;
  storePath = name: value:
    if builtins.typeOf value == "path"
    then builtins.path { path = value; name = "skillful-${name}"; }
    else value;
  projectSource = storePath "project" src;
  projectRoot = projectSource + "/${projectDir}";
  declarationRoot = "${src}/${projectDir}";
  harnessDir = ../harnesses;
  harnessFiles = builtins.attrNames (lib.filterAttrs (name: type: type == "regular" && lib.hasSuffix ".json" name) (builtins.readDir harnessDir));
  facts = builtins.listToAttrs (map (file:
    let value = builtins.fromJSON (builtins.readFile (harnessDir + "/${file}"));
    in {
      name = value.name;
      inherit value;
    }) harnessFiles);
  harnesses = builtins.attrNames facts;
  setupDeclarations = (import ./parseMod.nix { inherit lib facts; }) (declarationRoot + "/skill.mod");
  setupNames = builtins.attrNames setupDeclarations;
  pathConflict = left: right:
    left == "." || right == "." || left == right
    || lib.hasPrefix "${left}/" right
    || lib.hasPrefix "${right}/" left;
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
  renderTree = derivationName: renderArgs: pkgs.runCommand derivationName {
    nativeBuildInputs = [ engineCli ];
    inherit projectSource projectRoot;
    dependencySources = builtins.attrValues resolvedOverrides;
    extraRootSources = map (entry: entry.src) (normalizedExtraRoots.skills ++ normalizedExtraRoots.commands);
  } ''
    export HOME="$TMPDIR/home"
    export XDG_CACHE_HOME="$TMPDIR/cache"
    export XDG_STATE_HOME="$TMPDIR/state"
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
    skillful render ${lib.escapeShellArgs renderArgs} --project "$projectRoot" --source-root "$projectSource" --out "$TMPDIR/rendered" ${lib.escapeShellArgs (overrideArgs ++ extraArgs)}
    cp -r "$TMPDIR/rendered" "$out"
  '';
  rendered = renderTree "skillful-project-render" [ ];
  forHarness = name:
    if !(builtins.hasAttr name facts)
    then throw "unknown skillful harness ${name}; known: ${lib.concatStringsSep ", " harnesses}"
    else
      let harnessRendered = renderTree "skillful-${name}-render" [ "--harness" name ];
      in {
        installPaths = facts.${name}.installPaths.home;
        skills = "${harnessRendered}/${name}/skills";
        commands = "${harnessRendered}/${name}/commands";
        rules = "${harnessRendered}/${name}/rules.md";
      };
  forSetup = name:
    if !(builtins.hasAttr name setupDeclarations)
    then throw "unknown skillful setup ${name}; known: ${lib.concatStringsSep ", " setupNames}"
    else
      let
        setup = setupDeclarations.${name};
        resolvedHarnesses = map (harness:
          if facts.${harness.name}.commandMerge == "skill" && harness.paths ? commands
          then throw "skillful setup ${name} harness ${harness.name} does not support a commands path"
          else harness // {
            paths = facts.${harness.name}.installPaths.${setup.root} // harness.paths;
          }
        ) setup.harnesses;
        setupRendered = renderTree "skillful-setup-${name}-render" [ name ];
        entries = lib.concatMap (harness: lib.mapAttrsToList (category: destination: {
          inherit category destination;
          harness = harness.name;
          recursive = category != "rules";
          source = "${setupRendered}/${harness.name}/${if category == "rules" then "rules.md" else category}";
        }) harness.paths) resolvedHarnesses;
        destinations = map (entry: entry.destination) entries;
        duplicateDestinations = builtins.length destinations != builtins.length (lib.unique destinations);
        overlappingDestinations = builtins.any (left: builtins.any (right:
          left != right && pathConflict left right
        ) destinations) destinations;
        files = builtins.listToAttrs (map (entry: {
          name = entry.destination;
          value = builtins.removeAttrs entry [ "destination" ];
        }) entries);
        outputs = builtins.listToAttrs (map (harness: {
          name = harness.name;
          value = {
            installPaths = harness.paths;
            skills = "${setupRendered}/${harness.name}/skills";
            commands = "${setupRendered}/${harness.name}/commands";
            rules = "${setupRendered}/${harness.name}/rules.md";
          };
        }) resolvedHarnesses);
      in if duplicateDestinations
      then throw "skillful setup ${name} has duplicate destinations"
      else if overlappingDestinations
      then throw "skillful setup ${name} has overlapping destinations"
      else {
        inherit name outputs files;
        root = setup.root;
        selection = setup.selection;
        harnesses = map (harness: harness.name) resolvedHarnesses;
        installPaths = builtins.listToAttrs (map (harness: { name = harness.name; value = harness.paths; }) resolvedHarnesses);
        rendered = setupRendered;
      };
  cli = pkgs.writeShellApplication {
    name = "skillful";
    runtimeInputs = [ engineCli ];
    text = ''
      case "''${1-}" in
        list|setup|inspect|check|diff|manifest|schema|render|install) exec ${engineCli}/bin/skillful "$@" ${escapedProjectArgs} ;;
        *) exec ${engineCli}/bin/skillful "$@" ;;
      esac
    '';
  };
  contract = pkgs.runCommand "skillful-project-contract" {
    nativeBuildInputs = [ engineCli pkgs.jq ];
    inherit projectSource projectRoot;
  } ''
    export HOME="$TMPDIR/home"
    export XDG_CACHE_HOME="$TMPDIR/cache"
    export XDG_STATE_HOME="$TMPDIR/state"
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$out"
    skillful schema --format json ${escapedProjectArgs} > "$TMPDIR/schema.json"
    skillful manifest --format json ${escapedProjectArgs} > "$TMPDIR/manifest.json"
    jq -s '{ schemaVersion: 1, schema: .[0].schema, manifest: { setups: .[1].setups, harnesses: .[1].harnesses } }' "$TMPDIR/schema.json" "$TMPDIR/manifest.json" > "$out/contract.json"
  '';
  checks = {
    render = rendered;
    strict = pkgs.runCommand "skillful-project-strict-check" { nativeBuildInputs = [ cli ]; } ''
      skillful check --strict --format json > "$out"
    '';
  };
in
{
  inherit harnesses forHarness forSetup cli contract checks rendered;
  setups = setupNames;
  installPaths = builtins.mapAttrs (_: value: value.installPaths.home) facts;
}
