// left on at having to account for leaving vc with role to a vc that doesnt even have the role
require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMembers,

		// other intents
	],
});

client.login(process.env.BOT_TOKEN).catch(console.error);

const maxUsers = 2; // Maximum number of users with an active role per category
let categoryVCs = {}; // Stores users per category
const categoryRoles = {
	'1171940894748975164': { role: '2v2-1', maxUsers: 4, queue: [] },
	'1171941634045399050': { role: '2v2-2', maxUsers: 4, queue: [] },
	'1171941702920048653': { role: '2v2-3', maxUsers: 4, queue: [] },
	'1171975454689861652': { role: '3v3-1', maxUsers: 6, queue: [] },
	'1171974873724227594': { role: '3v3-2', maxUsers: 6, queue: [] },
	'1171976124314701824': { role: '3v3-3', maxUsers: 6, queue: [] },
	'1171976202299387914': { role: '4v4-1', maxUsers: 8, queue: [] },
	'1171976258654056528': { role: '4v4-2', maxUsers: 8, queue: [] },
	'1171977118754816002': { role: '4v4-3', maxUsers: 8, queue: [] },
	'1171977358325071903': { role: '5v5-1', maxUsers: 10, queue: [] },
	'1171977397365641286': { role: '5v5-2', maxUsers: 10, queue: [] },
	'1171977440915103774': { role: '5v5-3', maxUsers: 10, queue: [] },
	'1172027340394610719': { role: '1v1-1', maxUsers: 2, queue: [] },
	'1172027226540224512': { role: '1v1-2', maxUsers: 2, queue: [] },
	'1173421161753882744': { role: '1v1-3', maxUsers: 2, queue: [] },
	// Add more category-role mappings as needed
};

client.on('ready', () => {
	console.log(`Logged in as ${client.user.tag}!`);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
	console.log('Voice State Updated');

	const categoryIDs = Object.keys(categoryRoles);

	// Check if the voice state update is within our categories of interest
	if (
		!categoryIDs.includes(newState.channel?.parentId) &&
		!categoryIDs.includes(oldState.channel?.parentId)
	) {
		return;
	}

	const guild = newState.guild;

	if (!guild) return; // Exit if guild is not available

	// Ensure guild data is available
	if (!guild.available) {
		console.log('Guild is not available');
		return;
	}

	// When someone joins a voice channel in the categories of interest
	if (!oldState.channel && newState.channel) {
		console.log('hello');
		const categoryID = newState.channel.parentId;

		console.log('Category ID: ' + categoryID);
		const roleName = categoryRoles[categoryID].role;
		console.log('Role name: ' + roleName);

		const activeRole = guild.roles.cache.find((role) => role.name === roleName);
		console.log('Active role: ' + activeRole);

		if (!categoryVCs[categoryID]) {
			categoryVCs[categoryID] = new Set();
		}

		if (
			categoryVCs[categoryID].size >= categoryRoles[categoryID].maxUsers &&
			activeRole
		) {
			categoryRoles[categoryID].queue.push(newState.member.id);
		} else if (
			categoryVCs[categoryID].size < categoryRoles[categoryID].maxUsers &&
			activeRole
		) {
			newState.member.roles.add(activeRole).catch(console.error);
			categoryVCs[categoryID].add(newState.member.id);
		}
	}

	// When someone leaves a voice channel

	if (oldState.channel && !newState.channel) {
		const categoryID = oldState.channel.parentId;

		const roleName = categoryRoles[categoryID].role;
		const activeRole = guild.roles.cache.find((role) => role.name === roleName);

		if (categoryVCs[categoryID].has(oldState.member.id) && activeRole) {
			//remove role and delete from cat vc
			oldState.member.roles.remove(activeRole).catch(console.error);
			categoryVCs[categoryID].delete(oldState.member.id);

			// Attempt to assign the role to another user if someone leaves
			if (categoryRoles[categoryID].queue.size > 0) {
				memberId = categoryRoles[categoryID].queue.shift();
				const member = await guild.members.fetch(memberId).catch(console.error);
				member.roles.add(activeRole).catch(console.error);
				categoryVCs[categoryID].add(memberID);
			}
		} else {
			index = categoryRoles[categoryID].queue.indexOf(oldState.member.id);
			categoryRoles[categoryID].queue.splice(index, 1);
		}
	} else if (oldState.channel && newState.channel) {
		if (oldState.channel.parentId != newState.channel.parentId) {
			const categoryID = oldState.channel.parentId;
			const roleName = categoryRoles[categoryID].role;
			const activeRole = guild.roles.cache.find(
				(role) => role.name === roleName
			);
			oldState.member.roles.remove(activeRole).catch(console.error);

			if (categoryVCs[categoryID].has(oldState.member.id) && activeRole) {
				//remove role and delete from cat vc

				categoryVCs[categoryID].delete(oldState.member.id);

				// Attempt to assign the role to another user if someone leaves
				if (categoryRoles[categoryID].queue.size > 0) {
					memberId = categoryRoles[categoryID].queue.shift();
					const member = await guild.members
						.fetch(memberId)
						.catch(console.error);
					member.roles.add(activeRole).catch(console.error);
					categoryVCs[categoryID].add(memberID);
				}
			} else {
				index = categoryRoles[categoryID].queue.indexOf(oldState.member.id);
				categoryRoles[categoryID].queue.splice(index, 1);
			}

			const categoryID2 = newState.channel.parentId;
			if (categoryRoles[categoryID2]) {
				const roleName2 = categoryRoles[categoryID2].role;
				const activeRole2 = guild.roles.cache.find(
					(role) => role.name === roleName2
				);

				if (!categoryVCs[categoryID2]) {
					categoryVCs[categoryID2] = new Set();
				}

				if (
					categoryVCs[categoryID2].size >=
						categoryRoles[categoryID2].maxUsers &&
					activeRole2
				) {
					categoryRoles[categoryID2].queue.push(newState.member.id);
				} else if (
					categoryVCs[categoryID2].size < categoryRoles[categoryID2].maxUsers &&
					activeRole2
				) {
					newState.member.roles.add(activeRole2).catch(console.error);
					categoryVCs[categoryID2].add(newState.member.id);
				}
			}
		}
	}
});

client.login(process.env.BOT_TOKEN);
