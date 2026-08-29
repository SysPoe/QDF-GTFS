#pragma once
#include "GTFS.h"
#include <string>

namespace gtfs {

// Snapshot binary version. Increment when logical schema changes.
constexpr uint32_t SNAPSHOT_VERSION = 2;
constexpr uint32_t SNAPSHOT_MAGIC = 0x51444653; // 'QDFS'
constexpr uint32_t SNAPSHOT_MIN_VERSION = 2;

// Architecture hash is computed from arch + endianness at runtime; stored in header for rejection.

struct SnapshotHeader {
    uint32_t magic = SNAPSHOT_MAGIC;
    uint32_t version = SNAPSHOT_VERSION;
    uint32_t archHash = 0;
    uint32_t headerSize = sizeof(SnapshotHeader);
    uint64_t fileSize = 0;
    uint32_t stringPoolCount = 0;
    uint32_t agencyCount = 0;
    uint32_t calendarCount = 0;
    uint32_t calendarDateCount = 0;
    uint32_t routeCount = 0;
    uint32_t stopCount = 0;
    uint32_t stopTimeCount = 0;
    uint32_t tripCount = 0;
    uint32_t transferCount = 0;
    uint32_t shapeCount = 0;
    uint32_t feedInfoCount = 0;
    uint32_t staticOccupancyCount = 0;
    uint32_t checksum = 0; // crc32 of rest of file
};

bool saveCompiledSnapshot(const GTFSData& data, const std::string& path, const std::string& contentKey, std::string& error);
bool loadCompiledSnapshot(GTFSData& data, const std::string& path, const std::string& expectedContentKey, std::string& error);
uint32_t computeArchHash();
std::string computeSnapshotContentKey(const std::vector<std::string>& feedIds, const std::vector<std::string>& feedHashes, int mergeStrategy, const std::vector<std::string>& filesToLoad, uint32_t snapshotVersion);

}
