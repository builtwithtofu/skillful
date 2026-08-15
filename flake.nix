{
  description = "Author agent skills once, render them per harness";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      mkProject = import ./nix/mkProject.nix { inherit self; };
    in
    {
      lib = { inherit mkProject; };

      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          skillful = import ./nix/package.nix { inherit pkgs; src = self; };
        in
        {
          inherit skillful;
          default = skillful;
        });

      legacyPackages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          fixtureProject = mkProject { inherit pkgs; src = ./templates/basic; };
        });

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          skillful = import ./nix/package.nix { inherit pkgs; src = self; };
          bunDeps = import ./nix/bun-deps.nix { inherit pkgs; };
          fixture = mkProject { inherit pkgs; src = ./templates/basic; };
          lockedFixture = mkProject { inherit pkgs; src = ./tests/fixtures/locked-project; };
          sourceMaintenanceFixture = mkProject {
            inherit pkgs;
            src = ./tests/fixtures/source-maintenance-project;
            projectDir = "agent";
          };
          githubTree = builtins.fetchTree {
            type = "github";
            owner = "angular";
            repo = "skills";
            rev = "db574d779823fad75472413768838c909f4bf7fa";
            narHash = "sha256-BQBdtRIqsxRJ9i+pUggiTZNUyF6gut97iEBzEtKgx2o=";
          };
        in
        {
          cli = pkgs.runCommandLocal "skillful-cli-tests" {
            nativeBuildInputs = [ pkgs.bun pkgs.gitMinimal pkgs.gnutar ];
          } ''
            cd ${self}
            NODE_PATH=${bunDeps} bun test cli
            touch "$out"
          '';
          standalone = pkgs.runCommandLocal "skillful-standalone-check" { } ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            env -i HOME="$HOME" PATH=/nonexistent ${skillful}/bin/skillful init --dir "$TMPDIR/project"
            env -i HOME="$HOME" PATH=/nonexistent ${skillful}/bin/skillful list harnesses --project "$TMPDIR/project" > "$TMPDIR/harnesses"
            env -i HOME="$HOME" PATH=/nonexistent ${skillful}/bin/skillful render --project "$TMPDIR/project" --out "$TMPDIR/rendered"
            grep -Fx opencode-v2 "$TMPDIR/harnesses"
            test -f "$TMPDIR/rendered/pi/skills/example/SKILL.md"
            touch "$out"
          '';
          source-maintenance = pkgs.runCommandLocal "skillful-source-maintenance-check" {
            nativeBuildInputs = [ sourceMaintenanceFixture.cli pkgs.gitMinimal pkgs.gnutar ];
          } ''
            export HOME="$TMPDIR/home"
            export XDG_CACHE_HOME="$TMPDIR/cache"
            mkdir -p "$HOME" "$XDG_CACHE_HOME" "$out"
            test -f ${(sourceMaintenanceFixture.forHarness "pi").skills}/agent-jj/SKILL.md

            remote="$TMPDIR/remote"
            mkdir -p "$remote/angular/angular-skill" "$remote/browser/agent-browser"
            printf '%s\n' '---' 'name: angular-skill' 'description: angular fixture' '---' > "$remote/angular/angular-skill/SKILL.md"
            printf '%s\n' '---' 'name: agent-browser' 'description: browser fixture' '---' > "$remote/browser/agent-browser/SKILL.md"
            git -C "$remote" init -b main >/dev/null
            git -C "$remote" config user.email test@example.invalid
            git -C "$remote" config user.name Test
            git -C "$remote" add .
            git -C "$remote" commit -m initial >/dev/null

            workspace="$TMPDIR/workspace"
            work="$workspace/agent"
            cp -r ${./tests/fixtures/source-maintenance-project} "$workspace"
            chmod -R u+w "$workspace"
            git -C "$workspace" init -b main >/dev/null

            cat >> "$work/skill.mod" <<EOF

            require "git:file://$remote@main#browser" as agent-browser (
              only agent-browser
            )

            require "git:file://$remote@main#angular" as angular-skills (
              only angular-skill
            )
            EOF

            mkdir "$work/nested"
            (cd "$work/nested" && skillful update angular-skills)

            skillful update agent-browser --project "$work"

            cp "$work/skill.lock" "$TMPDIR/lock.before"
            rm -rf "$XDG_CACHE_HOME/skillful"
            skillful fetch --project "$work"
            cmp "$TMPDIR/lock.before" "$work/skill.lock"
            ${skillful}/bin/skillful check --strict --format json --project "$work" --source-root "$workspace" > "$out/pinned-check.json"
          '';
          fixture-render = fixture.checks.render;
          fixture-strict = fixture.checks.strict;
          locked-render = lockedFixture.checks.render;
          github-transport = pkgs.runCommand "skillful-github-transport" {
            nativeBuildInputs = [ pkgs.bun pkgs.gnutar pkgs.cacert ];
            outputHashAlgo = "sha256";
            outputHashMode = "recursive";
            outputHash = "sha256-Vz1x6g+awrVYM9aNcbjsjsMGX+TGOMrI7OpobqVjK9Y=";
          } ''
            export HOME="$TMPDIR/home"
            export XDG_CACHE_HOME="$TMPDIR/cache"
            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            mkdir -p "$HOME" "$XDG_CACHE_HOME" "$out"
            bun ${self}/cli/github-integration.ts "$XDG_CACHE_HOME" ${githubTree.outPath}
            printf 'ok\n' > "$out/result"
          '';
        });

      templates.basic = {
        path = ./templates/basic;
        description = "A small skillful project";
        welcomeText = ''
          A basic skillful project was created. Edit skill.mod and the
          resources under skills/, commands/, and rules/ before rendering.
        '';
      };
    };
}
