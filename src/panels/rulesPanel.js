const { EmbedBuilder } = require('discord.js');

function buildRulesPanel() {
  const generalEmbed = new EmbedBuilder()
    .setTitle('Server Rules & Match Regulations')
    .setColor(0xe74c3c)
    .setDescription('By participating in any match (wager or XP), you agree to all rules below. Violations result in penalties up to permanent ban and forfeiture of funds.');

  const gameSettingsEmbed = new EmbedBuilder()
    .setTitle('Game Settings')
    .setColor(0x3498db)
    .addFields(
      { name: 'Hardpoint', value: 'Score Limit: 250\nTime Limit: 600s\nMaps: Summit, Hacienda, Combine, Takeoff, Arsenal' },
      { name: 'Search & Destroy', value: 'Round Win Limit: 9\nRound Time Limit: 120s\nOvertime: Yes (20 rounds)\nMaps: Tunisia, Firing Range, Slums, Meltdown, Coastal' },
      { name: 'Control', value: 'Score Limit: 3\nTime Limit: 90s\nMaps: Raid, Standoff, Crossroads Strike' },
    );

  const bannedWeaponsEmbed = new EmbedBuilder()
    .setTitle('Restricted Weapons')
    .setColor(0xe74c3c)
    .setDescription('Any new content added to the game is restricted for 21 days after release. Administration may restrict or lift restrictions at their discretion.')
    .addFields(
      { name: 'Snipers', value: 'NA-45, SVD, XPR, SO-14', inline: true },
      { name: 'Shotguns', value: 'Argus', inline: true },
      { name: 'Pistols', value: 'Shorty', inline: true },
      { name: 'Launchers', value: 'D13 Sector, FHJ-18, SMRS, Thumper', inline: true },
      { name: 'Wildcards', value: 'All Wildcards restricted', inline: true },
    );

  const bannedAttachmentsEmbed = new EmbedBuilder()
    .setTitle('Restricted Attachments')
    .setColor(0xe74c3c)
    .addFields(
      { name: 'All Guns — Weapon Perks', value: 'Akimbo, Disable' },
      { name: 'All Guns — Ammo', value: 'All Thermite, Dragon\'s Breath, Explosive, and Incendiary Ammo' },
      { name: 'Shotguns', value: 'Slug Ammo' },
      { name: 'Specific Weapons', value: [
        '3-Line Rifle: EMPRESS 514MM, Bipod, KOVALEVSKAYA S01',
        '.41 AE: 32-Round Mags',
        'AS VAL: 15 Round FMG Mag',
        'BP-50: Leroy 438mm, Recoil Booster',
        'CR AMAX: M67 Ammo',
        'Crossbow: Thermite/Gas/Sticky Bolts',
        'CX9: 9mm Hollow Point',
        'DLQ: Concussion Ammo',
        'DRH: OTM Mag',
        'Hades: Heartseeker',
        'HS0405: Thunder Rounds',
        'HVK: Large Caliber Mag',
        'M4: Underbarrel Launcher',
        'Oden: OWC Ranger/Marksman Barrel',
        'RAM 7: FORGE TAC Eclipse',
        'RPD: Infinite Ammo',
        'Type 19: Hi-Accuracy Sniper Ammo',
      ].join('\n') },
    );

  const bannedUtilityEmbed = new EmbedBuilder()
    .setTitle('Restricted Utility & Perks')
    .setColor(0xe74c3c)
    .addFields(
      { name: 'Restricted Lethal', value: 'C4, Cluster Grenade, Contact Grenade, Molotov, Thermite, Trip Mine' },
      { name: 'Restricted Tactical', value: 'Cryo Bomb, Decoy Grenade, Douser Grenade, Echo Grenade, Flash Drone, Gas Grenades, Heartbeat Sensor, Stim Shot, Storm Ball, Trip Sensor' },
      { name: 'Restricted Red Perks', value: 'Martyrdom, Overclock, Pinpoint, Restock, Tactician' },
      { name: 'Restricted Green Perks', value: 'Quick Fix, Recon, Tracker, Vulture' },
      { name: 'Restricted Blue Perks', value: 'Alert, Assassin, Engineer, Hardline, High Alert, Persistence, Unit Support, Demo Expert, Survival Training' },
    );

  const allowedEmbed = new EmbedBuilder()
    .setTitle('Allowed Operator Skills & Scorestreaks')
    .setColor(0x2ecc71)
    .addFields(
      { name: 'Allowed Operator Skills', value: 'Annihilator, Claw, Death Machine, Equalizer, Gravity Spikes, Gravity Vortex Gun, Purifier, Sparrow, Tempest, War Machine' },
      { name: 'Allowed Scorestreaks', value: 'Hunter Killer Drone, Predator Missile, EMP' },
    );

  const cosmeticsEmbed = new EmbedBuilder()
    .setTitle('Cosmetic Restrictions')
    .setColor(0x95a5a6)
    .addFields(
      { name: 'Utility Skins', value: 'All Legendary Utility Skins restricted' },
      { name: 'Emotes', value: 'All Emotes restricted during matches' },
      { name: 'Restricted Operator Skins', value: 'Cosmic Silverback, Death Angel Alice (Trench/Shrouded Maiden), Florence (Night Terror), Golem (Everglade), Grinch (Night Fang/Wreath Havoc/The Lionheart), Roze (Murk/Rook), Zombie (Wicht Warden)' },
    );

  const weaponRolesEmbed = new EmbedBuilder()
    .setTitle('Weapon Class Roles')
    .setColor(0x3498db)
    .setDescription([
      '**6 Weapon Class Roles:** AR, SMG, LMG, Shotgun, Marksman, Sniper',
      '',
      '**Team Pool:** 3 AR, 3 SMG, 1 LMG, 1 Shotgun, 1 Marksman, 1 Sniper',
      '',
      'Each player gets 2 roles. Players may not equip loadouts outside their assigned roles for the entire series.',
      'Players cannot have two of the same role. Roles do not apply to secondary weapons or picked-up weapons.',
      'Each team manages their own pool independently.',
      '',
      '**Example:**',
      'Player 1 — AR / SMG',
      'Player 2 — SMG / Shotgun',
      'Player 3 — AR / LMG',
      'Player 4 — AR / Sniper',
      'Player 5 — SMG / Marksman',
    ].join('\n'));

  const noShowEmbed = new EmbedBuilder()
    .setTitle('No-Show Rules')
    .setColor(0xf39c12)
    .setDescription([
      '**Wager Matches:** 15 minutes to show up — auto forfeit if no-show',
      '**XP Matches:** 15 minutes to show up — -300 XP penalty for no-show',
      '**NeatQueue:** 5 minutes per NeatQueue rules',
      '',
      'Staff verifies no-shows by checking voice channel join activity.',
    ].join('\n'));

  const matchRulesEmbed = new EmbedBuilder()
    .setTitle('Match & Dispute Rules')
    .setColor(0x9b59b6)
    .setDescription([
      '**Match Rules:**',
      '• Must use your registered COD Mobile account (matching UID)',
      '• All matches are final once both parties accept',
      '• Both captains must report results honestly',
      '• Disconnections are not grounds for restart unless both teams agree',
      '• Maps are randomly selected by the bot — no changes after match starts',
      '',
      '**Wager Specifics:**',
      '• Entry: $0.50–$100 USDC per player',
      '• Funds locked from your account during match, released when decided',
      '• Winners receive the full pot split equally',
      '',
      '**Disputes:**',
      '• Post evidence (screenshots/video) in the match shared channel',
      '• Evidence must show match result AND player UIDs',
      '• Staff decisions are final',
      '• Falsified evidence = permanent ban + fund forfeiture',
      '',
      '**Prohibited:** Cheating, win trading, DDoS, multiple accounts, match fixing, XP boosting, impersonating staff. All result in permanent ban.',
    ].join('\n'))
    .setFooter({ text: 'Source: callofduty.com/mobile/esports/esports-settings' });

  return { embeds: [generalEmbed, gameSettingsEmbed, bannedWeaponsEmbed, bannedAttachmentsEmbed, bannedUtilityEmbed, allowedEmbed, cosmeticsEmbed, weaponRolesEmbed, noShowEmbed, matchRulesEmbed] };
}

async function postRulesPanel(client) {
  const channelId = process.env.RULES_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] RULES_CHANNEL_ID not set — skipping rules panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }

    const panel = buildRulesPanel();
    // Discord max 10 embeds per message — split if needed
    if (panel.embeds.length <= 10) {
      await channel.send(panel);
    } else {
      await channel.send({ embeds: panel.embeds.slice(0, 10) });
      await channel.send({ embeds: panel.embeds.slice(10) });
    }
    console.log('[Panel] Posted rules panel');
  } catch (err) {
    console.error('[Panel] Failed to post rules panel:', err.message);
  }
}

module.exports = { buildRulesPanel, postRulesPanel };
