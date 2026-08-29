/**
 * Puts the app's own icon and details on the Windows executable.
 *
 * A SEA build is a copy of the Node runtime, so without this it carries Node's
 * icon and calls itself "Node.js JavaScript Runtime" in the task manager and in
 * every file property dialog. For something a person installs on their desktop,
 * that is not a cosmetic detail — it is the difference between an application
 * and a stray binary.
 *
 * `resedit` is pure JavaScript, so this needs no Windows SDK and no native
 * module, and it is a dev dependency that never runs at runtime.
 *
 * Windows only. macOS icons live in an .app bundle and Linux takes its icon
 * from the .desktop entry, both of which are handled where those are written.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { NtExecutable, NtExecutableResource, Resource, Data } from 'resedit';

export function brandWindows(exePath, icoPath, { version, description, product, company }) {
  // The Node binary ships Authenticode-signed, and resedit refuses a signed
  // file by default. Dropping the certificate is correct rather than a
  // workaround: injecting the app invalidates it a moment later anyway, and
  // leaving a broken signature attached is worse than having none.
  const exe = NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  // Node's own icon and strings are already in there; they have to go, or the
  // new ones sit alongside them and Windows picks whichever it likes.
  const icon = Data.IconFile.from(readFileSync(icoPath));
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1,
    1033, // en-US
    icon.icons.map((i) => i.data),
  );

  // Four parts, always: Windows version resources are major.minor.patch.build,
  // and "1.0.0" spread into that leaves the language argument landing in the
  // build slot.
  const [major = 1, minor = 0, patch = 0] = version.split('.').map(Number);

  const info = Resource.VersionInfo.createEmpty();
  info.setFileVersion(major, minor, patch, 0, 1033);
  info.setProductVersion(major, minor, patch, 0, 1033);
  info.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      FileDescription: description,
      ProductName: product,
      CompanyName: company,
      LegalCopyright: `MIT licensed. ${company}.`,
      OriginalFilename: 'viral-radar.exe',
      InternalName: 'viral-radar',
    },
  );
  info.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
}
