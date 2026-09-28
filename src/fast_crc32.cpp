#include "miniz.h"

#include <array>
#include <cstdint>

// Eight CRC bytes per iteration; miniz still validates every extracted ZIP entry.
extern "C" mz_ulong mz_crc32(mz_ulong initial, const unsigned char* data, size_t length) {
    if (!data) return MZ_CRC32_INIT;

    static constexpr auto tables = [] {
        std::array<std::array<uint32_t, 256>, 8> result{};
        for (uint32_t byte = 0; byte < 256; ++byte) {
            uint32_t crc = byte;
            for (int bit = 0; bit < 8; ++bit) {
                crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320u : 0u);
            }
            result[0][byte] = crc;
        }
        for (size_t slice = 1; slice < result.size(); ++slice) {
            for (size_t byte = 0; byte < 256; ++byte) {
                const uint32_t previous = result[slice - 1][byte];
                result[slice][byte] = result[0][previous & 0xff] ^ (previous >> 8);
            }
        }
        return result;
    }();

    uint32_t crc = ~static_cast<uint32_t>(initial);
    while (length >= 8) {
        crc = tables[7][(crc ^ data[0]) & 0xff] ^
              tables[6][((crc >> 8) ^ data[1]) & 0xff] ^
              tables[5][((crc >> 16) ^ data[2]) & 0xff] ^
              tables[4][((crc >> 24) ^ data[3]) & 0xff] ^
              tables[3][data[4]] ^ tables[2][data[5]] ^
              tables[1][data[6]] ^ tables[0][data[7]];
        data += 8;
        length -= 8;
    }
    while (length--) crc = tables[0][(crc ^ *data++) & 0xff] ^ (crc >> 8);
    return ~crc;
}
