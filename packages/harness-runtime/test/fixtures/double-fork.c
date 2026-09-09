#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>

static void stay_alive(void) {
    for (;;) pause();
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    pid_t first = fork();
    if (first < 0) return 3;
    if (first == 0) {
        if (setsid() < 0) _exit(4);
        pid_t second = fork();
        if (second < 0) _exit(5);
        if (second > 0) _exit(0);
        int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (fd < 0) _exit(6);
        if (dprintf(fd, "%ld\n", (long)getpid()) < 0 || fsync(fd) != 0 || close(fd) != 0) _exit(7);
        stay_alive();
    }
    stay_alive();
    return 0;
}
