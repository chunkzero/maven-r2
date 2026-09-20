package com.example.mavenr2;

/** A small published API for the example build. */
public final class Greeting {
    private Greeting() {}

    /** @return a greeting */
    public static String message() {
        return "Hello from Maven R2";
    }
}
